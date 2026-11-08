import { useMemo } from 'react';
import { MISSING_COLOR } from '../../lib/income';
import type { CountyEncoding } from './encoding';
import { countyPathData, type MapLayout } from './projection';

interface FallbackMapProps {
  layout: MapLayout;
  encodings: Map<string, CountyEncoding>;
  selectedFips: string | null;
  onHover: (fips: string | null, clientX: number, clientY: number) => void;
  onSelect: (fips: string) => void;
}

/** Flat SVG choropleth shown when WebGL cannot run; uses the same projection and colors as the 3D map. */
export function FallbackMap({ layout, encodings, selectedFips, onHover, onSelect }: FallbackMapProps) {
  const paths = useMemo(() => layout.counties.map((county) => ({ fips: county.fips, d: countyPathData(county) })), [layout]);
  const { minX, minZ, maxX, maxZ } = layout.bounds;
  const pad = Math.max(maxX - minX, maxZ - minZ) * 0.02;
  const selected = paths.find((path) => path.fips === selectedFips);

  return (
    <svg
      className="map-fallback-svg"
      viewBox={`${minX - pad} ${minZ - pad} ${maxX - minX + pad * 2} ${maxZ - minZ + pad * 2}`}
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label="Flat map of Texas counties colored by mean household income"
      onPointerLeave={(event) => onHover(null, event.clientX, event.clientY)}
    >
      {paths.map((path) => (
        <path
          key={path.fips}
          d={path.d}
          className="map-fallback-county"
          fill={encodings.get(path.fips)?.color ?? MISSING_COLOR}
          onPointerMove={(event) => onHover(path.fips, event.clientX, event.clientY)}
          onClick={() => onSelect(path.fips)}
        />
      ))}
      {selected && <path d={selected.d} className="map-fallback-selected" />}
    </svg>
  );
}
