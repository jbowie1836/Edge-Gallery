import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type HTMLAttributes,
  type KeyboardEvent,
} from 'react';
import type { CountyMapProps } from '../types';
import { encodeCounties } from './map/encoding';
import { CountyMapEngine, type EngineCallbacks, type ViewMode } from './map/engine';
import { FallbackMap } from './map/FallbackMap';
import { MapLegend } from './map/MapLegend';
import { MapToolbar, ModeToggle } from './map/MapControls';
import { MapTooltip } from './map/MapTooltip';
import { buildMapLayout } from './map/projection';
import './map/map.css';

type Status = 'starting' | 'ready' | 'unsupported' | 'lost';

const ZOOM_FACTOR = 0.72;
const ROTATE_STEP = 20;
const TILT_STEP = 8;
const PAN_STEP = 0.12;
const TOUCH_TOOLTIP_MS = 3500;

function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (notify: () => void) => {
      if (typeof window === 'undefined' || !window.matchMedia) return () => {};
      const list = window.matchMedia(query);
      list.addEventListener('change', notify);
      return () => list.removeEventListener('change', notify);
    },
    [query],
  );
  return useSyncExternalStore(
    subscribe,
    () => typeof window !== 'undefined' && !!window.matchMedia && window.matchMedia(query).matches,
    () => false,
  );
}

/** Keeps the tooltip beside the pointer and inside the map, flipping sides near the edges. */
function placeTooltip(tooltip: HTMLElement | null, viewport: HTMLElement | null, clientX: number, clientY: number) {
  if (!tooltip || !viewport) return;
  const bounds = viewport.getBoundingClientRect();
  const width = tooltip.offsetWidth;
  const height = tooltip.offsetHeight;
  const gap = 16;
  const margin = 8;
  let x = clientX - bounds.left + gap;
  let y = clientY - bounds.top + gap;
  if (x + width > bounds.width - margin) x = clientX - bounds.left - width - gap;
  if (y + height > bounds.height - margin) y = clientY - bounds.top - height - gap;
  x = Math.max(margin, Math.min(x, bounds.width - width - margin));
  y = Math.max(margin, Math.min(y, bounds.height - height - margin));
  tooltip.style.transform = `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0)`;
}

export default function CountyMap({ geometry, counties, selectedFips, onSelect }: CountyMapProps) {
  const layout = useMemo(() => buildMapLayout(geometry), [geometry]);
  const encodings = useMemo(() => encodeCounties(layout.counties, counties), [layout, counties]);
  const missingCount = useMemo(() => [...encodings.values()].filter((encoding) => encoding.income === null).length, [encodings]);

  const [mode, setMode] = useState<ViewMode>('3d');
  const [status, setStatus] = useState<Status>('starting');
  const [hoveredFips, setHoveredFips] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const [keyboardHelp, setKeyboardHelp] = useState(false);
  const reducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)');
  const coarsePointer = useMediaQuery('(pointer: coarse)');

  const id = useId();
  const helpId = `${id}-help`;
  const legendTitleId = `${id}-legend`;

  const viewportRef = useRef<HTMLDivElement>(null);
  const canvasHostRef = useRef<HTMLDivElement>(null);
  const labelLayerRef = useRef<HTMLDivElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const needleRef = useRef<SVGGElement>(null);
  const engineRef = useRef<CountyMapEngine | null>(null);
  const pointerRef = useRef({ x: 0, y: 0 });
  const onSelectRef = useRef(onSelect);
  const mapPickRef = useRef<string | null>(null);
  const appliedSelectionRef = useRef<{ engine: CountyMapEngine | null; fips: string | null }>({ engine: null, fips: null });
  const touchTimerRef = useRef(0);
  const modeRef = useRef(mode);
  const reducedMotionRef = useRef(reducedMotion);

  useLayoutEffect(() => {
    onSelectRef.current = onSelect;
  }, [onSelect]);

  const announce = useCallback((message: string) => {
    // A trailing zero-width space toggles so repeated messages are still announced.
    setAnnouncement((previous) => (previous === message ? `${message}\u200b` : message));
  }, []);

  useEffect(() => {
    const host = canvasHostRef.current;
    const labelLayer = labelLayerRef.current;
    if (!host || !labelLayer) return;

    const callbacks: EngineCallbacks = {
      onHover: ({ fips, clientX, clientY, pointerType }) => {
        if (pointerType === 'touch' || touchTimerRef.current) return;
        pointerRef.current = { x: clientX, y: clientY };
        setHoveredFips(fips);
        placeTooltip(tooltipRef.current, viewportRef.current, clientX, clientY);
      },
      onPick: ({ fips, clientX, clientY, pointerType }) => {
        mapPickRef.current = fips;
        onSelectRef.current(fips);
        if (pointerType === 'touch') {
          // No hover on touch screens: show the values briefly where the county was tapped.
          window.clearTimeout(touchTimerRef.current);
          pointerRef.current = { x: clientX, y: clientY };
          setHoveredFips(fips);
          touchTimerRef.current = window.setTimeout(() => {
            touchTimerRef.current = 0;
            setHoveredFips(null);
          }, TOUCH_TOOLTIP_MS);
        }
      },
      onGesture: () => {
        if (!touchTimerRef.current) return;
        window.clearTimeout(touchTimerRef.current);
        touchTimerRef.current = 0;
        setHoveredFips(null);
      },
      onView: ({ bearing }) => {
        needleRef.current?.style.setProperty('transform', `rotate(${bearing.toFixed(1)}deg)`);
      },
      onContextLost: () => setStatus('lost'),
      onContextRestored: () => setStatus('ready'),
    };

    let engine: CountyMapEngine;
    try {
      engine = new CountyMapEngine(host, labelLayer, callbacks, { mode: modeRef.current, reducedMotion: reducedMotionRef.current });
    } catch (error) {
      console.warn('3D county map unavailable; showing the flat fallback map.', error);
      setStatus('unsupported');
      return;
    }
    engineRef.current = engine;
    setStatus('ready');
    return () => {
      window.clearTimeout(touchTimerRef.current);
      touchTimerRef.current = 0;
      engine.dispose();
      if (engineRef.current === engine) engineRef.current = null;
    };
  }, []);

  useEffect(() => {
    engineRef.current?.setData(layout, encodings);
  }, [layout, encodings, status]);

  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;
    const previous = appliedSelectionRef.current;
    const changed = previous.engine === engine && previous.fips !== selectedFips;
    const fromMap = selectedFips !== null && selectedFips === mapPickRef.current;
    // Selections made elsewhere (search, table) bring the county into view; map clicks leave the camera alone.
    engine.setSelected(selectedFips, { focus: changed && !fromMap && selectedFips !== null });
    appliedSelectionRef.current = { engine, fips: selectedFips };
    mapPickRef.current = null;
  }, [selectedFips, status]);

  useEffect(() => {
    modeRef.current = mode;
    engineRef.current?.setMode(mode);
  }, [mode]);

  useEffect(() => {
    reducedMotionRef.current = reducedMotion;
    engineRef.current?.setReducedMotion(reducedMotion);
  }, [reducedMotion]);

  useLayoutEffect(() => {
    if (hoveredFips) placeTooltip(tooltipRef.current, viewportRef.current, pointerRef.current.x, pointerRef.current.y);
  }, [hoveredFips]);

  const changeMode = (next: ViewMode) => {
    if (next === mode) return;
    setMode(next);
    announce(next === '3d' ? '3D view: color and height show income' : '2D view: flat map colored by income');
  };

  const resetView = useCallback(() => {
    engineRef.current?.resetView();
    announce('View reset to all of Texas');
  }, [announce]);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const engine = engineRef.current;
    if (!engine || event.altKey || event.ctrlKey || event.metaKey) return;
    const { shiftKey } = event;
    switch (event.key) {
      case 'ArrowLeft':
        if (shiftKey) engine.rotateBy(-ROTATE_STEP);
        else engine.panBy(-PAN_STEP, 0);
        break;
      case 'ArrowRight':
        if (shiftKey) engine.rotateBy(ROTATE_STEP);
        else engine.panBy(PAN_STEP, 0);
        break;
      case 'ArrowUp':
        if (shiftKey) engine.tiltBy(-TILT_STEP);
        else engine.panBy(0, PAN_STEP);
        break;
      case 'ArrowDown':
        if (shiftKey) engine.tiltBy(TILT_STEP);
        else engine.panBy(0, -PAN_STEP);
        break;
      case '+':
      case '=':
        engine.zoomBy(ZOOM_FACTOR);
        break;
      case '-':
      case '_':
        engine.zoomBy(1 / ZOOM_FACTOR);
        break;
      case '0':
      case 'Home':
        resetView();
        break;
      case 'n':
      case 'N':
        engine.resetBearing();
        break;
      default:
        return;
    }
    event.preventDefault();
  };

  const interactive = status === 'starting' || status === 'ready';
  const fallback = status === 'unsupported' || status === 'lost';
  const hovered = hoveredFips ? encodings.get(hoveredFips) ?? null : null;
  const selected = selectedFips ? encodings.get(selectedFips) ?? null : null;

  let hint: string;
  if (fallback) hint = coarsePointer ? 'Tap a county for details' : 'Hover or click a county for details';
  else if (keyboardHelp) hint = mode === '3d' ? 'Arrows pan · Shift+arrows rotate and tilt · +/− zoom · 0 resets' : 'Arrows pan · +/− zoom · 0 resets';
  else if (coarsePointer) hint = mode === '3d' ? 'Drag to rotate · Pinch to zoom · Tap a county' : 'Drag to pan · Pinch to zoom · Tap a county';
  else hint = mode === '3d' ? 'Drag to rotate · Right-drag or Shift-drag to pan · Scroll to zoom · Click a county' : 'Drag to pan · Scroll to zoom · Click a county';

  const viewportProps: HTMLAttributes<HTMLDivElement> = interactive
    ? {
        role: 'application',
        'aria-roledescription': 'interactive map',
        'aria-label': `Texas counties, ${mode === '3d' ? '3D' : '2D'} view`,
        'aria-describedby': helpId,
        tabIndex: 0,
        onKeyDown: handleKeyDown,
        onFocus: (event) => setKeyboardHelp(event.currentTarget.matches(':focus-visible')),
        onBlur: () => setKeyboardHelp(false),
      }
    : {};

  const fullHelp =
    mode === '3d'
      ? 'Interactive 3D map. Color and height show mean household income. Drag to rotate, right-drag or Shift-drag to pan, scroll or pinch to zoom, and click a county to select it. With the map focused: arrow keys pan, Shift with Left or Right rotates, Shift with Up or Down tilts, plus and minus zoom, N faces north and 0 resets the view. Every county is also listed in the county table.'
      : 'Interactive flat map. Color shows mean household income. Drag to pan, scroll or pinch to zoom, and click a county to select it. With the map focused: arrow keys pan, plus and minus zoom and 0 resets the view. Every county is also listed in the county table.';

  return (
    <section className="county-map" data-mode={mode} data-status={status} aria-label="Map of mean household income by Texas county">
      <div ref={viewportRef} className="map-viewport" {...viewportProps}>
        <div ref={canvasHostRef} className="map-canvas-host" />
        <div ref={labelLayerRef} className="map-labels" aria-hidden="true" />
        {fallback && (
          <div className="map-fallback">
            <FallbackMap
              layout={layout}
              encodings={encodings}
              selectedFips={selectedFips}
              onSelect={onSelect}
              onHover={(fips, clientX, clientY) => {
                pointerRef.current = { x: clientX, y: clientY };
                setHoveredFips(fips);
                placeTooltip(tooltipRef.current, viewportRef.current, clientX, clientY);
              }}
            />
          </div>
        )}
        {layout.counties.length === 0 && <p className="map-empty">County boundaries are not available.</p>}
        <div ref={tooltipRef} className="map-tooltip" data-visible={hovered ? 'true' : 'false'} aria-hidden="true">
          {hovered && <MapTooltip encoding={hovered} selected={hovered.fips === selectedFips} touch={coarsePointer} />}
        </div>
      </div>

      {interactive && <ModeToggle mode={mode} onChange={changeMode} />}
      {interactive && (
        <MapToolbar
          mode={mode}
          needleRef={needleRef}
          onZoom={(direction) => engineRef.current?.zoomBy(direction > 0 ? ZOOM_FACTOR : 1 / ZOOM_FACTOR)}
          onRotate={(direction) => engineRef.current?.rotateBy(direction * ROTATE_STEP)}
          onTilt={(direction) => engineRef.current?.tiltBy(direction * TILT_STEP)}
          onResetBearing={() => engineRef.current?.resetBearing()}
          onReset={resetView}
        />
      )}
      {fallback && (
        <p className="map-notice" role="status">
          {status === 'lost'
            ? '3D rendering paused because the graphics context was lost. Showing a flat map until it recovers.'
            : '3D view unavailable: this browser could not start WebGL. Showing a flat map; every county is also in the table.'}
        </p>
      )}

      <p className="map-hint map-hint-top" aria-hidden="true">
        {hint}
      </p>
      <div className="map-bottom-left">
        <p className="map-hint map-hint-inline">{hint}</p>
        <MapLegend mode={fallback ? '2d' : mode} hovered={hovered} selected={selected} missingCount={missingCount} titleId={legendTitleId} />
      </div>

      <p className="map-sr-only" id={helpId}>
        {fullHelp}
      </p>
      <p className="map-sr-only" aria-live="polite">
        {announcement}
      </p>
    </section>
  );
}
