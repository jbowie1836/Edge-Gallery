import type { ReactNode, RefObject } from 'react';
import { House, Minus, Plus, RotateCcw, RotateCw } from 'lucide-react';
import type { ViewMode } from './engine';

interface ModeToggleProps {
  mode: ViewMode;
  onChange: (mode: ViewMode) => void;
}

export function ModeToggle({ mode, onChange }: ModeToggleProps) {
  return (
    <div className="map-mode" role="group" aria-label="Map view mode">
      <button
        type="button"
        className="map-mode-option"
        aria-pressed={mode === '2d'}
        title="Flat map: color shows income"
        onClick={() => onChange('2d')}
      >
        2D
      </button>
      <button
        type="button"
        className="map-mode-option"
        aria-pressed={mode === '3d'}
        title="3D map: color and height show income"
        onClick={() => onChange('3d')}
      >
        3D
      </button>
    </div>
  );
}

interface ToolButtonProps {
  label: string;
  shortcut: string;
  onClick: () => void;
  className?: string;
  children: ReactNode;
}

function ToolButton({ label, shortcut, onClick, className, children }: ToolButtonProps) {
  return (
    <button
      type="button"
      className={className ? `map-tool ${className}` : 'map-tool'}
      aria-label={label}
      title={`${label} (map shortcut: ${shortcut})`}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function TiltIcon({ toward }: { toward: 'horizon' | 'overhead' }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {toward === 'horizon' ? (
        <>
          <path d="M4 20h16l-3.5-7h-9z" />
          <path d="M12 10V3" />
          <path d="m9 6 3-3 3 3" />
        </>
      ) : (
        <>
          <rect x="5" y="13" width="14" height="7" rx="1" />
          <path d="M12 3v7" />
          <path d="m9 7 3 3 3-3" />
        </>
      )}
    </svg>
  );
}

interface MapToolbarProps {
  mode: ViewMode;
  needleRef: RefObject<SVGGElement | null>;
  onZoom: (direction: 1 | -1) => void;
  onRotate: (direction: 1 | -1) => void;
  onTilt: (direction: 1 | -1) => void;
  onResetBearing: () => void;
  onReset: () => void;
}

export function MapToolbar({ mode, needleRef, onZoom, onRotate, onTilt, onResetBearing, onReset }: MapToolbarProps) {
  const iconProps = { size: 18, strokeWidth: 2.1, 'aria-hidden': true } as const;
  return (
    <div className="map-toolbar" role="group" aria-label="Map view controls">
      <div className="map-tool-group">
        <ToolButton label="Zoom in" shortcut="+" onClick={() => onZoom(1)}>
          <Plus {...iconProps} />
        </ToolButton>
        <ToolButton label="Zoom out" shortcut="−" onClick={() => onZoom(-1)}>
          <Minus {...iconProps} />
        </ToolButton>
      </div>
      {mode === '3d' && (
        <div className="map-tool-group">
          <ToolButton label="Reset rotation to north up" shortcut="N" onClick={onResetBearing} className="map-compass">
            <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
              <circle cx="12" cy="12" r="10" className="map-compass-ring" />
              <g ref={needleRef} className="map-compass-needle">
                <path d="M12 3.5 15 12H9z" className="map-compass-north" />
                <path d="M12 20.5 9 12h6z" className="map-compass-south" />
              </g>
            </svg>
          </ToolButton>
          <ToolButton label="Rotate counterclockwise" shortcut="Shift+Left" onClick={() => onRotate(-1)}>
            <RotateCcw {...iconProps} />
          </ToolButton>
          <ToolButton label="Rotate clockwise" shortcut="Shift+Right" onClick={() => onRotate(1)}>
            <RotateCw {...iconProps} />
          </ToolButton>
          <ToolButton label="Tilt toward the horizon" shortcut="Shift+Down" onClick={() => onTilt(1)}>
            <TiltIcon toward="horizon" />
          </ToolButton>
          <ToolButton label="Tilt toward an overhead view" shortcut="Shift+Up" onClick={() => onTilt(-1)}>
            <TiltIcon toward="overhead" />
          </ToolButton>
        </div>
      )}
      <div className="map-tool-group">
        <ToolButton label="Reset view" shortcut="0" onClick={onReset}>
          <House {...iconProps} />
        </ToolButton>
      </div>
    </div>
  );
}
