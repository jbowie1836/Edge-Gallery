import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MapPin, RefreshCw, TriangleAlert } from 'lucide-react';
import { formatCurrency } from './lib/income';
import type { CountyIncome } from './types';
import BrandMark from './components/ui/BrandMark';
import CountySearch from './components/ui/CountySearch';
import CountyTable from './components/ui/CountyTable';
import HeroStats from './components/ui/HeroStats';
import MapBoundary from './components/ui/MapBoundary';
import Methodology from './components/ui/Methodology';
import SelectionPanel from './components/ui/SelectionPanel';
import SourceFooter from './components/ui/SourceFooter';
import { buildJoinReport, displayCountyName, formatMoe, rankCounties, summarizeCounties } from './components/ui/atlasModel';
import { useAtlasData } from './components/ui/useAtlasData';

const loadCountyMap = () => import('./components/CountyMap');
const CountyMap = lazy(loadCountyMap);
const NO_COUNTIES: CountyIncome[] = [];

type SelectionSource = 'map' | 'search' | 'panel' | 'table';

function readCountyParam(): string | null {
  const value = new URLSearchParams(window.location.search).get('county');
  return value && /^\d{5}$/.test(value) ? value : null;
}

function describeSelection(county: CountyIncome): string {
  const name = displayCountyName(county.name);
  if (county.meanIncome === null) return `${name} selected. No published mean household income estimate.`;
  const moe = county.marginOfError === null ? '' : `, margin of error ${formatMoe(county.marginOfError)}`;
  return `${name} selected. Mean annual household income ${formatCurrency(county.meanIncome)}${moe}.`;
}

function MapStatus({ label }: { label: string }) {
  return (
    <div className="explorer__status" role="status">
      <span className="spinner" aria-hidden="true" />
      <p>{label}</p>
    </div>
  );
}

function PanelSkeleton() {
  return (
    <div className="selection selection--loading" aria-hidden="true">
      <span className="skeleton skeleton--eyebrow" />
      <span className="skeleton skeleton--title" />
      <span className="skeleton skeleton--value" />
      <span className="skeleton skeleton--line" />
      <span className="skeleton skeleton--line skeleton--short" />
    </div>
  );
}

export default function App() {
  const { state, retry } = useAtlasData();
  const ready = state.status === 'ready' ? state : null;
  const [selectedFips, setSelectedFips] = useState<string | null>(readCountyParam);
  const [announcement, setAnnouncement] = useState('');
  const [focusRequest, setFocusRequest] = useState(0);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const explorerRef = useRef<HTMLElement>(null);

  // Fetch the WebGL chunk alongside the data instead of after it.
  useEffect(() => {
    loadCountyMap().catch(() => undefined);
  }, []);

  const derived = useMemo(() => {
    if (!ready) return null;
    const { data, geometry } = ready;
    return {
      byFips: new Map(data.counties.map((county) => [county.fips, county])),
      ranks: rankCounties(data.counties),
      summary: summarizeCounties(data.counties),
      join: buildJoinReport(geometry, data.counties),
    };
  }, [ready]);

  const byFips = derived?.byFips;
  const selectedCounty = (selectedFips && byFips?.get(selectedFips)) || null;
  const activeFips = selectedCounty?.fips ?? null;

  const selectCounty = useCallback((fips: string, source: SelectionSource) => {
    const county = byFips?.get(fips);
    if (!county) return;
    setSelectedFips(fips);
    setAnnouncement(describeSelection(county));
    if (source === 'panel' || source === 'table') setFocusRequest((value) => value + 1);
    if (source === 'table') {
      const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
      explorerRef.current?.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
    }
  }, [byFips]);

  const handleMapSelect = useCallback((fips: string) => selectCounty(fips, 'map'), [selectCounty]);
  const handleSearchSelect = useCallback((fips: string) => selectCounty(fips, 'search'), [selectCounty]);
  const handlePanelSelect = useCallback((fips: string) => selectCounty(fips, 'panel'), [selectCounty]);
  const handleTableSelect = useCallback((fips: string) => selectCounty(fips, 'table'), [selectCounty]);
  const clearSelection = useCallback(() => {
    setSelectedFips(null);
    setAnnouncement('Selection cleared. Showing the Texas overview.');
    setFocusRequest((value) => value + 1);
  }, []);

  // Selection changes that swap the panel content move focus to its new heading.
  useEffect(() => {
    if (focusRequest > 0) headingRef.current?.focus({ preventScroll: true });
  }, [focusRequest]);

  // Keep ?county=FIPS in the address bar so a view can be shared or reloaded.
  useEffect(() => {
    if (!derived) return;
    const url = new URL(window.location.href);
    if (activeFips) url.searchParams.set('county', activeFips);
    else url.searchParams.delete('county');
    if (url.href !== window.location.href) window.history.replaceState(window.history.state, '', url);
  }, [derived, activeFips]);

  return (
    <div className="app">
      <a className="skip-link" href="#explorer">Skip to the map explorer</a>

      <header id="top" className="site-header">
        <div className="site-header__inner">
          <a className="brand" href="#top">
            <BrandMark className="brand__mark" />
            <span className="brand__text">
              <span className="brand__name">Lone Star</span>
              <span className="brand__divider" aria-hidden="true">/</span>
              <span className="brand__tag">An Income Atlas</span>
            </span>
          </a>
          <nav className="site-nav" aria-label="Sections">
            <a href="#explorer">Map</a>
            <a href="#counties">Counties</a>
            <a href="#methodology">Methodology</a>
            <a href="#sources">Sources</a>
          </nav>
        </div>
      </header>

      <main className="page">
        <section className="intro" aria-labelledby="page-title">
          <div className="intro__heading">
            <p className="eyebrow">
              <MapPin size={14} aria-hidden="true" />
              Texas · Mean annual household income
            </p>
            <h1 id="page-title">
              254 counties.
              <br />
              <em>One Texas.</em>
            </h1>
          </div>
          <div className="intro__aside">
            <p className="intro__lede">
              A different view of prosperity: mean annual household income for every Texas county, from the
              U.S. Census Bureau’s American Community Survey. Color and height rise together with income.
            </p>
            <HeroStats data={ready?.data ?? null} join={derived?.join ?? null} failed={state.status === 'error'} />
          </div>
        </section>

        <section
          id="explorer"
          ref={explorerRef}
          tabIndex={-1}
          className={`explorer${state.status === 'error' ? ' explorer--error' : ''}`}
          aria-labelledby="explorer-title"
          aria-busy={state.status === 'loading'}
        >
          <h2 id="explorer-title" className="visually-hidden">County map explorer</h2>
          {state.status === 'error' ? (
            <div className="load-error" role="alert">
              <TriangleAlert size={30} aria-hidden="true" className="load-error__icon" />
              <h3>The atlas data didn’t load</h3>
              <p>{state.message}</p>
              <p className="load-error__hint">No estimates are shown until the official data loads.</p>
              <button
                type="button"
                className="btn btn--primary"
                onClick={() => {
                  retry();
                  explorerRef.current?.focus({ preventScroll: true });
                }}
              >
                <RefreshCw size={16} aria-hidden="true" /> Try again
              </button>
            </div>
          ) : (
            <>
              <div className="explorer__search">
                <CountySearch counties={ready?.data.counties ?? NO_COUNTIES} onSelect={handleSearchSelect} disabled={!ready} />
              </div>
              <div className="explorer__map">
                <div className="explorer__map-frame">
                  {ready ? (
                    <MapBoundary>
                      <Suspense fallback={<MapStatus label="Loading the 3D map…" />}>
                        <CountyMap
                          geometry={ready.geometry}
                          counties={ready.data.counties}
                          selectedFips={activeFips}
                          onSelect={handleMapSelect}
                        />
                      </Suspense>
                    </MapBoundary>
                  ) : (
                    <MapStatus label="Loading county boundaries and Census estimates…" />
                  )}
                </div>
              </div>
              <div className="explorer__details">
                {ready && derived ? (
                  <SelectionPanel
                    county={selectedCounty}
                    data={ready.data}
                    ranks={derived.ranks}
                    summary={derived.summary}
                    headingRef={headingRef}
                    onSelect={handlePanelSelect}
                    onClear={clearSelection}
                  />
                ) : (
                  <PanelSkeleton />
                )}
              </div>
            </>
          )}
        </section>

        {ready && derived && (
          <>
            <CountyTable
              counties={ready.data.counties}
              ranks={derived.ranks}
              metadata={ready.data.metadata}
              selectedFips={activeFips}
              onSelect={handleTableSelect}
            />
            <Methodology data={ready.data} summary={derived.summary} join={derived.join} />
          </>
        )}
      </main>

      <SourceFooter metadata={ready?.data.metadata ?? null} />
      <p className="visually-hidden" role="status" aria-live="polite">{announcement}</p>
    </div>
  );
}
