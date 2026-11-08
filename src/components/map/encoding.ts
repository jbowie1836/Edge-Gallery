import type { CountyIncome } from '../../types';
import { getIncomeColor, getIncomeHeight, INCOME_STOPS } from '../../lib/income';

/** Lowest slab used in 2D so geometry never collapses to zero thickness. */
export const FLAT_HEIGHT = 0.02;

export interface CountyEncoding {
  fips: string;
  displayName: string;
  /** Mean annual household income; null when no estimate exists (never coerced to 0). */
  income: number | null;
  marginOfError: number | null;
  households: number | null;
  /** True when the boundary had no matching income record at all. */
  unmatched: boolean;
  color: string;
  /** Full 3D extrusion height in world units, straight from the shared getIncomeHeight helper. */
  height: number;
}

export function countyDisplayName(name: string): string {
  const trimmed = name.replace(/,\s*Texas$/i, '').trim();
  if (!trimmed) return 'Unnamed county';
  return /\bcounty$/i.test(trimmed) ? trimmed : `${trimmed} County`;
}

function finiteOrNull(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Joins a boundary feature to its income record by FIPS code; a missing record stays missing. */
export function encodeCounty(fips: string, boundaryName: string, record: CountyIncome | undefined): CountyEncoding {
  const income = finiteOrNull(record?.meanIncome);
  return {
    fips,
    displayName: countyDisplayName(record?.name || boundaryName || fips),
    income,
    marginOfError: finiteOrNull(record?.marginOfError),
    households: finiteOrNull(record?.households),
    unmatched: record === undefined,
    color: getIncomeColor(income),
    height: getIncomeHeight(income),
  };
}

export function encodeCounties(
  boundaries: { fips: string; name: string }[],
  records: CountyIncome[],
): Map<string, CountyEncoding> {
  const byFips = new Map(records.map((record) => [record.fips, record]));
  return new Map(boundaries.map((boundary) => [boundary.fips, encodeCounty(boundary.fips, boundary.name, byFips.get(boundary.fips))]));
}

/** Height actually drawn for an extrusion factor between 0 (2D) and 1 (3D). */
export function displayHeight(height: number, extrusion: number): number {
  return Math.max(FLAT_HEIGHT, height * extrusion);
}

const LEGEND_MIN = INCOME_STOPS[0].value;
const LEGEND_MAX = INCOME_STOPS[INCOME_STOPS.length - 1].value;

export function formatCompactCurrency(value: number): string {
  return `$${Math.round(value / 1000).toLocaleString('en-US')}k`;
}

export interface LegendTick {
  value: number;
  /** 0–1 position along the legend bar. */
  offset: number;
  label: string;
}

/** Legend ticks at the shared color stops; the end labels note that colors clamp beyond them. */
export function legendTicks(): LegendTick[] {
  return INCOME_STOPS.map((stop, index) => {
    const label = formatCompactCurrency(stop.value);
    return {
      value: stop.value,
      offset: (stop.value - LEGEND_MIN) / (LEGEND_MAX - LEGEND_MIN),
      label: index === 0 ? `≤${label}` : index === INCOME_STOPS.length - 1 ? `${label}+` : label,
    };
  });
}

/** CSS gradient that matches getIncomeColor, which interpolates linearly in sRGB like CSS does. */
export function legendGradient(): string {
  const stops = INCOME_STOPS.map((stop) => `${stop.color} ${(((stop.value - LEGEND_MIN) / (LEGEND_MAX - LEGEND_MIN)) * 100).toFixed(2)}%`);
  return `linear-gradient(90deg, ${stops.join(', ')})`;
}

export function legendPosition(value: number | null): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  return Math.min(1, Math.max(0, (value - LEGEND_MIN) / (LEGEND_MAX - LEGEND_MIN)));
}

export function formatCount(value: number): string {
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(value);
}
