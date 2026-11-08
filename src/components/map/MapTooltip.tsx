import { formatCurrency } from '../../lib/income';
import { formatCount, type CountyEncoding } from './encoding';

interface MapTooltipProps {
  encoding: CountyEncoding;
  selected: boolean;
  touch: boolean;
}

export function MapTooltip({ encoding, selected, touch }: MapTooltipProps) {
  return (
    <>
      <p className="map-tooltip-name">{encoding.displayName}</p>
      {encoding.income === null ? (
        <p className="map-tooltip-missing">
          <span className="map-tooltip-swatch" style={{ background: encoding.color }} />
          No estimate available
          <span className="map-tooltip-note">Shown in gray; not the same as $0</span>
        </p>
      ) : (
        <>
          <p className="map-tooltip-label">Mean household income</p>
          <p className="map-tooltip-value">
            <span className="map-tooltip-swatch" style={{ background: encoding.color }} />
            {formatCurrency(encoding.income)}
          </p>
          {encoding.marginOfError !== null && (
            <p className="map-tooltip-meta">±{formatCurrency(encoding.marginOfError)} margin of error</p>
          )}
        </>
      )}
      {encoding.households !== null && <p className="map-tooltip-meta">{formatCount(encoding.households)} households</p>}
      <p className="map-tooltip-hint">{selected ? 'Selected · details in the panel' : touch ? 'Tap to select' : 'Click for details'}</p>
    </>
  );
}
