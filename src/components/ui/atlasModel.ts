import { formatCurrency, getIncomeColor } from '../../lib/income';
import type { AtlasData, AtlasMetadata, CountyFeatureCollection, CountyIncome } from '../../types';

export type SortKey = 'name' | 'meanIncome' | 'marginOfError' | 'households';
export type SortDirection = 'ascending' | 'descending';
export type CountyWithEstimate = CountyIncome & { meanIncome: number };

const countFormat = new Intl.NumberFormat('en-US');
const percentFormat = new Intl.NumberFormat('en-US', { style: 'percent', maximumFractionDigits: 1 });
const compactCurrencyFormat = new Intl.NumberFormat('en-US', {
  style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 0,
});
const dateFormat = new Intl.DateTimeFormat('en-US', { dateStyle: 'long', timeZone: 'UTC' });

export function hasEstimate(county: CountyIncome): county is CountyWithEstimate {
  return county.meanIncome !== null;
}

/** Accepts "Travis", "Travis County" or "Travis County, Texas" and returns "Travis County". */
export function displayCountyName(name: string): string {
  const base = name.replace(/,\s*Texas\s*$/i, '').trim();
  return /\bcounty$/i.test(base) ? base : `${base} County`;
}

export function shortCountyName(name: string): string {
  return displayCountyName(name).replace(/\s+county$/i, '');
}

export function compareCountyNames(a: CountyIncome, b: CountyIncome): number {
  return displayCountyName(a.name).localeCompare(displayCountyName(b.name), 'en', { sensitivity: 'base' })
    || a.fips.localeCompare(b.fips);
}

function normalizeText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/,\s*texas\s*$/, '')
    .replace(/\bcounty\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Relevance of a county for a search query: lower is better, null means no match. */
export function matchScore(county: CountyIncome, query: string): number | null {
  const q = normalizeText(query);
  if (!q) return null;
  const compactQuery = q.replace(/ /g, '');
  if (/^\d+$/.test(compactQuery)) {
    // Digits match the five-digit FIPS code or its three-digit county part.
    if (county.fips === compactQuery) return 0;
    if (compactQuery.length >= 3 && county.fips.startsWith(compactQuery)) return 1;
    if (county.fips.slice(2).startsWith(compactQuery)) return 2;
    return null;
  }
  const name = normalizeText(county.name);
  const compactName = name.replace(/ /g, '');
  if (name === q || compactName === compactQuery) return 0;
  if (name.startsWith(q) || compactName.startsWith(compactQuery)) return 1;
  if (name.split(' ').some((word) => word.startsWith(q))) return 2;
  if (name.includes(q) || compactName.includes(compactQuery)) return 3;
  return null;
}

/** Best matches first (exact, prefix, word prefix, substring), then alphabetical. */
export function searchCounties(counties: readonly CountyIncome[], query: string, limit = Infinity): CountyIncome[] {
  const scored: Array<{ county: CountyIncome; score: number }> = [];
  for (const county of counties) {
    const score = matchScore(county, query);
    if (score !== null) scored.push({ county, score });
  }
  scored.sort((a, b) => a.score - b.score || compareCountyNames(a.county, b.county));
  return scored.slice(0, limit).map((entry) => entry.county);
}

/** Keeps the input order; an empty query keeps every county. */
export function filterCounties(counties: readonly CountyIncome[], query: string): CountyIncome[] {
  if (!normalizeText(query)) return [...counties];
  return counties.filter((county) => matchScore(county, query) !== null);
}

/** Missing values always sort last, whichever direction is chosen. */
export function sortCounties(counties: readonly CountyIncome[], key: SortKey, direction: SortDirection): CountyIncome[] {
  const factor = direction === 'ascending' ? 1 : -1;
  return [...counties].sort((a, b) => {
    if (key === 'name') return factor * compareCountyNames(a, b);
    const left = a[key];
    const right = b[key];
    if (left === null || right === null) {
      if (left === right) return compareCountyNames(a, b);
      return left === null ? 1 : -1;
    }
    return factor * (left - right) || compareCountyNames(a, b);
  });
}

/** Competition ranking (1 = highest mean); tied counties share a rank, missing estimates are unranked. */
export function rankCounties(counties: readonly CountyIncome[]): Map<string, number> {
  const ordered = counties.filter(hasEstimate).sort((a, b) => b.meanIncome - a.meanIncome);
  const ranks = new Map<string, number>();
  ordered.forEach((county, index) => {
    const previous = ordered[index - 1];
    const rank = previous && previous.meanIncome === county.meanIncome ? ranks.get(previous.fips) : undefined;
    ranks.set(county.fips, rank ?? index + 1);
  });
  return ranks;
}

export interface CountySummary {
  total: number;
  withEstimate: number;
  missing: number;
  highest: CountyWithEstimate | null;
  lowest: CountyWithEstimate | null;
}

export function summarizeCounties(counties: readonly CountyIncome[]): CountySummary {
  const ordered = counties.filter(hasEstimate).sort((a, b) => b.meanIncome - a.meanIncome || compareCountyNames(a, b));
  return {
    total: counties.length,
    withEstimate: ordered.length,
    missing: counties.length - ordered.length,
    highest: ordered[0] ?? null,
    lowest: ordered[ordered.length - 1] ?? null,
  };
}

export interface JoinReport {
  boundaryCount: number;
  recordCount: number;
  matched: number;
  matchedWithEstimate: number;
  boundariesWithoutRecord: string[];
  recordsWithoutBoundary: string[];
}

/** Describes how county boundaries and income records line up by FIPS code. */
export function buildJoinReport(geometry: CountyFeatureCollection, counties: readonly CountyIncome[]): JoinReport {
  const records = new Map(counties.map((county) => [county.fips, county]));
  const boundaryFips = new Set(geometry.features.map((feature) => feature.properties.fips));
  let matched = 0;
  let matchedWithEstimate = 0;
  const boundariesWithoutRecord: string[] = [];
  for (const fips of boundaryFips) {
    const record = records.get(fips);
    if (!record) {
      boundariesWithoutRecord.push(fips);
      continue;
    }
    matched += 1;
    if (record.meanIncome !== null) matchedWithEstimate += 1;
  }
  return {
    boundaryCount: boundaryFips.size,
    recordCount: records.size,
    matched,
    matchedWithEstimate,
    boundariesWithoutRecord: boundariesWithoutRecord.sort(),
    recordsWithoutBoundary: [...records.keys()].filter((fips) => !boundaryFips.has(fips)).sort(),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Census annotation codes (e.g. -666666666) are negative: they mean "no estimate", never dollars. */
export function toEstimate(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function normalizeFips(value: unknown): string | null {
  const text = typeof value === 'number' ? String(value).padStart(5, '0') : typeof value === 'string' ? value.trim() : '';
  return /^\d{5}$/.test(text) ? text : null;
}

const REQUIRED_METADATA = ['source', 'sourceUrl', 'sourceVariable', 'period', 'releaseYear', 'dollarYear', 'definition'] as const;

/** Validates income.json; absent or annotated values become null and are never replaced. */
export function normalizeAtlasData(raw: unknown): AtlasData {
  if (!isRecord(raw) || !isRecord(raw.metadata) || !Array.isArray(raw.counties)) {
    throw new Error('The income file is missing its metadata or county list.');
  }
  const metadata = raw.metadata;
  const missingFields = REQUIRED_METADATA.filter((key) => metadata[key] === undefined || metadata[key] === null || metadata[key] === '');
  if (missingFields.length > 0) {
    throw new Error(`The income file metadata is incomplete (missing ${missingFields.join(', ')}).`);
  }
  const counties = raw.counties.map((entry: unknown, index): CountyIncome => {
    const fips = isRecord(entry) ? normalizeFips(entry.fips) : null;
    if (!isRecord(entry) || !fips || typeof entry.name !== 'string') {
      throw new Error(`County record ${index + 1} is missing a valid FIPS code or name.`);
    }
    return {
      fips,
      name: entry.name,
      meanIncome: toEstimate(entry.meanIncome),
      marginOfError: toEstimate(entry.marginOfError),
      households: toEstimate(entry.households),
    };
  });
  return {
    metadata: metadata as unknown as AtlasMetadata,
    stateMeanIncome: toEstimate(raw.stateMeanIncome),
    stateMarginOfError: toEstimate(raw.stateMarginOfError),
    counties,
  };
}

export function normalizeGeometry(raw: unknown): CountyFeatureCollection {
  if (!isRecord(raw) || raw.type !== 'FeatureCollection' || !Array.isArray(raw.features)) {
    throw new Error('The county boundary file is not a GeoJSON FeatureCollection.');
  }
  const invalid = raw.features.findIndex((feature: unknown) => (
    !isRecord(feature) || !isRecord(feature.properties) || typeof feature.properties.fips !== 'string'
  ));
  if (invalid >= 0) throw new Error(`County boundary ${invalid + 1} has no FIPS code.`);
  return raw as unknown as CountyFeatureCollection;
}

export function formatMoe(moe: number | null): string {
  return moe === null ? 'Not available' : `±${formatCurrency(moe)}`;
}

export function formatCount(value: number | null): string {
  return value === null ? 'Not available' : countFormat.format(value);
}

export function formatCompactCurrency(value: number): string {
  return compactCurrencyFormat.format(value);
}

export function formatPercent(value: number): string {
  return percentFormat.format(value);
}

export function formatPeriod(period: string): string {
  return period.replace(/(\d{4})\s*[-–—]\s*(\d{4})/, '$1–$2');
}

export function periodYears(period: string): { start: number; end: number } | null {
  const match = /(\d{4})\D+(\d{4})/.exec(period);
  return match ? { start: Number(match[1]), end: Number(match[2]) } : null;
}

/** Date-only strings are calendar dates, so format them in UTC to avoid an off-by-one day. */
export function formatDate(value: string): string {
  const date = new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00Z` : value);
  return Number.isNaN(date.getTime()) ? value : dateFormat.format(date);
}

export function ordinal(value: number): string {
  const lastTwo = value % 100;
  if (lastTwo >= 11 && lastTwo <= 13) return `${value}th`;
  return `${value}${['th', 'st', 'nd', 'rd'][value % 10] ?? 'th'}`;
}

export interface Comparison {
  direction: 'above' | 'below' | 'equal';
  share: number;
}

export function compareToReference(value: number | null, reference: number | null): Comparison | null {
  if (value === null || reference === null || reference === 0) return null;
  const share = (value - reference) / reference;
  if (Math.abs(share) < 0.005) return { direction: 'equal', share: 0 };
  return { direction: share > 0 ? 'above' : 'below', share: Math.abs(share) };
}

export function confidenceInterval(estimate: number | null, moe: number | null): { low: number; high: number } | null {
  return estimate === null || moe === null ? null : { low: estimate - moe, high: estimate + moe };
}

export function relativeMoe(estimate: number | null, moe: number | null): number | null {
  return estimate === null || moe === null || estimate === 0 ? null : moe / estimate;
}

export function positionInRange(value: number, min: number, max: number): number {
  if (max <= min) return 50;
  return Math.min(100, Math.max(0, ((value - min) / (max - min)) * 100));
}

/** Samples the shared map color scale so in-panel graphics match the map. */
export function incomeGradient(min: number, max: number, steps = 7): string {
  const colors = Array.from({ length: steps }, (_, index) => getIncomeColor(min + ((max - min) * index) / (steps - 1)));
  return `linear-gradient(90deg, ${colors.join(', ')})`;
}

function csvCell(value: string | number | null): string {
  if (value === null) return '';
  if (typeof value === 'number') return String(value);
  // Neutralise spreadsheet formula prefixes in text cells.
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** Every county in FIPS order; missing estimates stay empty cells, never 0. */
export function buildCountyCsv(
  counties: readonly CountyIncome[],
  ranks: ReadonlyMap<string, number>,
  metadata: Pick<AtlasMetadata, 'dollarYear'>,
): string {
  const header = [
    'fips', 'county', `mean_household_income_${metadata.dollarYear}_dollars`, 'margin_of_error_90pct', 'households', 'rank_highest_first',
  ];
  const rows = [...counties]
    .sort((a, b) => a.fips.localeCompare(b.fips))
    .map((county) => [
      county.fips,
      displayCountyName(county.name),
      county.meanIncome,
      county.marginOfError,
      county.households,
      ranks.get(county.fips) ?? null,
    ]);
  return `${[header, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n')}\r\n`;
}

export function csvFileName(metadata: Pick<AtlasMetadata, 'period'>): string {
  const years = periodYears(metadata.period);
  return `texas-mean-household-income-acs5-${years ? `${years.start}-${years.end}` : 'latest'}.csv`;
}

export function subjectDefinitionsUrl(releaseYear: number): string {
  return `https://www2.census.gov/programs-surveys/acs/tech_docs/subject_definitions/${releaseYear}_ACSSubjectDefinitions.pdf`;
}
