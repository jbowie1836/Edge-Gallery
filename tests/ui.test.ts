import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import CountyTable, { PAGE_SIZE } from '../src/components/ui/CountyTable';
import SelectionPanel from '../src/components/ui/SelectionPanel';
import {
  buildCountyCsv,
  buildJoinReport,
  compareToReference,
  csvFileName,
  displayCountyName,
  filterCounties,
  formatDate,
  formatPeriod,
  normalizeAtlasData,
  normalizeGeometry,
  ordinal,
  periodYears,
  rankCounties,
  searchCounties,
  shortCountyName,
  sortCounties,
  summarizeCounties,
} from '../src/components/ui/atlasModel';
import type { AtlasData, AtlasMetadata, CountyFeatureCollection, CountyIncome } from '../src/types';

// Synthetic fixture values for unit tests only; the app reads real data from /data/income.json.
const metadata: AtlasMetadata = {
  releaseYear: 2024,
  period: '2020-2024',
  dollarYear: 2024,
  source: 'U.S. Census Bureau, American Community Survey',
  sourceUrl: 'https://api.census.gov/data/2024/acs/acs5/subject',
  sourceVariable: 'S1901_C01_013E',
  releaseDate: '2026-01-29',
  fetchedAt: '2026-11-08T06:40:00Z',
  boundarySource: 'Census cartographic boundary file',
  boundaryUrl: 'https://www.census.gov/',
  boundaryYear: 2024,
  definition: 'Mean household income: aggregate household income divided by the number of households.',
  notes: '',
};

const county = (fips: string, name: string, meanIncome: number | null, marginOfError: number | null = 1000, households: number | null = 5000): CountyIncome => ({
  fips, name, meanIncome, marginOfError, households,
});

const counties: CountyIncome[] = [
  county('48001', 'Anderson County', 70000),
  county('48003', 'Andrews County', 90000),
  county('48005', 'Angelina County', 70000),
  county('48007', 'Aransas County', null, null),
  county('48009', 'Archer County', 0, 100),
  county('48123', 'DeWitt County', 65000),
  county('48453', 'Travis County', 150000, 1500, 500000),
];

const data: AtlasData = { metadata, stateMeanIncome: 100000, stateMarginOfError: 300, counties };

describe('county names', () => {
  it('normalizes Census and short names to one display form', () => {
    expect(displayCountyName('Travis')).toBe('Travis County');
    expect(displayCountyName('Travis County')).toBe('Travis County');
    expect(displayCountyName('Travis County, Texas')).toBe('Travis County');
    expect(shortCountyName('Travis County, Texas')).toBe('Travis');
  });
});

describe('county search', () => {
  it('ranks prefix matches ahead of substring matches', () => {
    expect(searchCounties(counties, 'an').map((c) => c.name)).toEqual([
      'Anderson County', 'Andrews County', 'Angelina County', 'Aransas County',
    ]);
  });

  it('finds counties by FIPS code, county code, suffix, spacing and accents', () => {
    expect(searchCounties(counties, '48453')[0].fips).toBe('48453');
    expect(searchCounties(counties, '453')[0].fips).toBe('48453');
    expect(searchCounties(counties, 'travis county')[0].fips).toBe('48453');
    expect(searchCounties(counties, 'Trávis')[0].fips).toBe('48453');
    expect(searchCounties(counties, 'de witt')[0].fips).toBe('48123');
    expect(searchCounties(counties, 'dewitt')[0].fips).toBe('48123');
  });

  it('respects the result limit and ignores blank queries', () => {
    expect(searchCounties(counties, 'a', 2)).toHaveLength(2);
    expect(searchCounties(counties, '   ')).toEqual([]);
    expect(searchCounties(counties, 'zzz')).toEqual([]);
  });

  it('filters the table without reordering it', () => {
    expect(filterCounties(counties, '')).toHaveLength(counties.length);
    expect(filterCounties(counties, 'an').map((c) => c.fips)).toEqual(['48001', '48003', '48005', '48007']);
  });
});

describe('ranking and sorting', () => {
  it('uses competition ranks, ranks $0 as a real value and leaves missing estimates unranked', () => {
    const ranks = rankCounties(counties);
    expect(ranks.get('48453')).toBe(1);
    expect(ranks.get('48003')).toBe(2);
    expect(ranks.get('48001')).toBe(3);
    expect(ranks.get('48005')).toBe(3);
    expect(ranks.get('48123')).toBe(5);
    expect(ranks.get('48009')).toBe(6);
    expect(ranks.has('48007')).toBe(false);
  });

  it('always lists missing estimates last, in both directions', () => {
    const descending = sortCounties(counties, 'meanIncome', 'descending');
    const ascending = sortCounties(counties, 'meanIncome', 'ascending');
    expect(descending[0].fips).toBe('48453');
    expect(descending.at(-1)?.fips).toBe('48007');
    expect(ascending[0].fips).toBe('48009');
    expect(ascending.at(-1)?.fips).toBe('48007');
  });

  it('sorts names alphabetically and breaks numeric ties by name', () => {
    expect(sortCounties(counties, 'name', 'descending')[0].name).toBe('Travis County');
    const tied = sortCounties(counties, 'meanIncome', 'descending').filter((c) => c.meanIncome === 70000);
    expect(tied.map((c) => c.name)).toEqual(['Anderson County', 'Angelina County']);
  });

  it('summarizes coverage without treating missing values as zero', () => {
    const summary = summarizeCounties(counties);
    expect(summary).toMatchObject({ total: 7, withEstimate: 6, missing: 1 });
    expect(summary.highest?.fips).toBe('48453');
    expect(summary.lowest?.fips).toBe('48009');
  });
});

describe('CSV export', () => {
  it('writes every county in FIPS order with empty cells for missing values', () => {
    const csv = buildCountyCsv(counties, rankCounties(counties), metadata);
    const lines = csv.trimEnd().split('\r\n');
    expect(lines[0]).toBe('fips,county,mean_household_income_2024_dollars,margin_of_error_90pct,households,rank_highest_first');
    expect(lines).toHaveLength(counties.length + 1);
    expect(lines[1]).toBe('48001,Anderson County,70000,1000,5000,3');
    expect(lines[4]).toBe('48007,Aransas County,,,5000,');
    expect(lines[5]).toBe('48009,Archer County,0,100,5000,6');
  });

  it('quotes special characters and neutralises formula prefixes', () => {
    const csv = buildCountyCsv([county('48999', 'Odd, "Quoted"', 1), county('48998', '=HYPERLINK()', 2)], new Map(), metadata);
    expect(csv).toContain('48999,"Odd, ""Quoted"" County",1');
    expect(csv).toContain("48998,'=HYPERLINK() County,2");
  });

  it('names the file after the ACS period', () => {
    expect(csvFileName(metadata)).toBe('texas-mean-household-income-acs5-2020-2024.csv');
  });
});

describe('data validation', () => {
  it('keeps zero, turns absent values and Census annotation codes into null', () => {
    const normalized = normalizeAtlasData({
      metadata,
      stateMeanIncome: 100000,
      stateMarginOfError: -555555555,
      counties: [
        { fips: '48001', name: 'Anderson County', meanIncome: 0, marginOfError: 0, households: 10 },
        { fips: '48003', name: 'Andrews County', meanIncome: -666666666, marginOfError: -222222222 },
        { fips: 48005, name: 'Angelina County', meanIncome: null, marginOfError: null, households: null },
      ],
    });
    expect(normalized.stateMeanIncome).toBe(100000);
    expect(normalized.stateMarginOfError).toBeNull();
    expect(normalized.counties[0]).toMatchObject({ meanIncome: 0, marginOfError: 0, households: 10 });
    expect(normalized.counties[1]).toMatchObject({ meanIncome: null, marginOfError: null, households: null });
    expect(normalized.counties[2].fips).toBe('48005');
  });

  it('rejects files without metadata, labels or FIPS codes', () => {
    expect(() => normalizeAtlasData({ counties: [] })).toThrow(/metadata/);
    expect(() => normalizeAtlasData({ metadata: { ...metadata, sourceVariable: '' }, counties: [] })).toThrow(/sourceVariable/);
    expect(() => normalizeAtlasData({ metadata, counties: [{ fips: '481', name: 'Bad' }] })).toThrow(/FIPS/);
    expect(() => normalizeGeometry({ type: 'Feature' })).toThrow(/FeatureCollection/);
    expect(() => normalizeGeometry({ type: 'FeatureCollection', features: [{ type: 'Feature', properties: {} }] })).toThrow(/FIPS/);
  });

  it('reports boundary and income records that fail to join', () => {
    const geometry = {
      type: 'FeatureCollection',
      features: ['48001', '48003', '48007', '48999'].map((fips) => ({
        type: 'Feature',
        properties: { fips, name: fips },
        geometry: { type: 'Polygon', coordinates: [] },
      })),
    } as unknown as CountyFeatureCollection;
    const report = buildJoinReport(geometry, counties);
    expect(report).toMatchObject({ boundaryCount: 4, recordCount: 7, matched: 3, matchedWithEstimate: 2 });
    expect(report.boundariesWithoutRecord).toEqual(['48999']);
    expect(report.recordsWithoutBoundary).toEqual(['48005', '48009', '48123', '48453']);
  });
});

describe('formatting helpers', () => {
  it('formats periods, release dates and ordinals', () => {
    expect(formatPeriod('2020-2024')).toBe('2020–2024');
    expect(periodYears('2020–2024')).toEqual({ start: 2020, end: 2024 });
    expect(formatDate('2026-01-29')).toBe('January 29, 2026');
    expect(formatDate('not a date')).toBe('not a date');
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 101, 254].map(ordinal)).toEqual([
      '1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd', '101st', '254th',
    ]);
  });

  it('compares with the published state mean only when both values exist', () => {
    expect(compareToReference(150000, 100000)).toEqual({ direction: 'above', share: 0.5 });
    expect(compareToReference(80000, 100000)).toEqual({ direction: 'below', share: 0.2 });
    expect(compareToReference(100200, 100000)?.direction).toBe('equal');
    expect(compareToReference(null, 100000)).toBeNull();
    expect(compareToReference(100000, null)).toBeNull();
  });
});

describe('rendered UI', () => {
  const ranks = rankCounties(counties);
  const summary = summarizeCounties(counties);
  const panel = (selected: CountyIncome | null) => renderToStaticMarkup(createElement(SelectionPanel, {
    county: selected, data, ranks, summary, headingRef: null, onSelect: () => undefined, onClear: () => undefined,
  }));

  it('labels the selected county with the metric, dollar year, MOE and rank', () => {
    const html = panel(counties[6]);
    expect(html).toContain('Selected county');
    expect(html).toContain('Travis County');
    expect(html).toContain('$150,000');
    expect(html).toContain('Mean annual household income');
    expect(html).toContain('2024 inflation-adjusted dollars');
    expect(html).toContain('±$1,500');
    expect(html).toContain('1st of 6');
    expect(html).toContain('50% above');
  });

  it('shows a missing estimate as unavailable, never as $0', () => {
    const html = panel(counties[3]);
    expect(html).toContain('No published estimate');
    expect(html).not.toMatch(/>\$0</);
    expect(panel(counties[4])).toMatch(/>\$0</);
  });

  it('uses the published Texas mean in the statewide overview', () => {
    const html = panel(null);
    expect(html).toContain('Texas at a glance');
    expect(html).toContain('$100,000');
    expect(html).toContain('±$300');
    expect(html).toContain('6 of 7');
  });

  it('renders a sorted, paginated table with missing values marked', () => {
    const many = Array.from({ length: 30 }, (_, index) => county(`48${String(index * 2 + 101).padStart(3, '0')}`, `County ${index}`, 50000 + index));
    const html = renderToStaticMarkup(createElement(CountyTable, {
      counties: [...many, counties[3]], ranks: rankCounties(many), metadata, selectedFips: null, onSelect: () => undefined,
    }));
    expect(html.match(/<tr[ >]/g)).toHaveLength(PAGE_SIZE + 1);
    expect(html).toContain('aria-sort="descending"');
    expect(html).toContain('Showing 1–20 of 31 counties');
    expect(html).toContain('Page 1 of 2');

    const lastPage = renderToStaticMarkup(createElement(CountyTable, {
      counties: [counties[3]], ranks: new Map(), metadata, selectedFips: '48007', onSelect: () => undefined,
    }));
    expect(lastPage).toContain('Not available');
    expect(lastPage).toContain('aria-current="true"');
    expect(lastPage).not.toMatch(/>\$0</);
  });
});
