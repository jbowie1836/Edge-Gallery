import { formatCurrency, MISSING_COLOR } from '../../lib/income';
import { legendGradient, legendPosition, legendTicks, type CountyEncoding } from './encoding';
import type { ViewMode } from './engine';

interface MapLegendProps {
  mode: ViewMode;
  hovered: CountyEncoding | null;
  selected: CountyEncoding | null;
  missingCount: number;
  titleId: string;
}

const TICKS = legendTicks();
const GRADIENT = legendGradient();

export function MapLegend({ mode, hovered, selected, missingCount, titleId }: MapLegendProps) {
  const markers = [
    { kind: 'selected', encoding: selected },
    { kind: 'hovered', encoding: hovered && hovered.fips !== selected?.fips ? hovered : null },
  ].flatMap(({ kind, encoding }) => {
    const position = encoding ? legendPosition(encoding.income) : null;
    return encoding && position !== null ? [{ kind, encoding, position }] : [];
  });

  return (
    <section className="map-legend" aria-labelledby={titleId}>
      <p className="map-legend-title" id={titleId}>
        Mean household income
      </p>
      <p className="map-legend-subtitle">Annual dollars per household</p>
      <div className="map-legend-scale">
        <div className="map-legend-bar" style={{ backgroundImage: GRADIENT }} aria-hidden="true" />
        {markers.map(({ kind, encoding, position }) => (
          <span
            key={kind}
            className={`map-legend-marker is-${kind}`}
            style={{ left: `${position * 100}%` }}
            title={`${encoding.displayName}: ${formatCurrency(encoding.income)}`}
            aria-hidden="true"
          />
        ))}
        <p className="map-sr-only">Color scale from pale yellow for $40,000 or less to deep green for $200,000 or more.</p>
        <ol className="map-legend-ticks">
          {TICKS.map((tick) => (
            <li key={tick.value} style={{ left: `${tick.offset * 100}%` }}>
              {tick.label}
            </li>
          ))}
        </ol>
      </div>
      <div className="map-legend-notes">
        <span className="map-legend-key">
          <span className="map-legend-swatch" style={{ background: MISSING_COLOR }} aria-hidden="true" />
          No estimate (not $0){missingCount > 0 ? ` · ${missingCount}` : ''}
        </span>
        {mode === '3d' && (
          <span className="map-legend-key">
            <svg width="14" height="12" viewBox="0 0 14 12" aria-hidden="true" className="map-legend-heights">
              <rect x="0.5" y="7" width="3" height="4.5" rx="0.5" />
              <rect x="5.5" y="4" width="3" height="7.5" rx="0.5" />
              <rect x="10.5" y="0.5" width="3" height="11" rx="0.5" />
            </svg>
            Height proportional to income
          </span>
        )}
      </div>
    </section>
  );
}
