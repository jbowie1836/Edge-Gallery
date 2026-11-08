import { readFileSync } from 'node:fs';
import { geoArea, geoBounds, geoContains } from 'd3-geo';
import type { Position } from 'geojson';
import { describe, expect, it } from 'vitest';
import type { AtlasData, CountyFeatureCollection } from '../src/types';

type CountyFeature = CountyFeatureCollection['features'][number];
type CsvRow = Record<string, string>;

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8');
const atlas = JSON.parse(read('../public/data/income.json')) as AtlasData;
const collection = JSON.parse(read('../public/data/texas-counties.geojson')) as CountyFeatureCollection;
const manifest = JSON.parse(read('../public/data/source/manifest.json')) as {
  outputs: { estimatesExtract: string; crossCheckExtract: string };
};
const s1901 = indexByGeoId(parseCsv(read(`../public/data/${manifest.outputs.estimatesExtract}`)));
const summaryFile = indexByGeoId(parseCsv(read(`../public/data/${manifest.outputs.crossCheckExtract}`)));
const features = collection.features;
const STATE_GEO_ID = '0400000US48';
// Texas county FIPS codes are the 254 odd numbers 001 through 507.
const TEXAS_FIPS = Array.from({ length: 254 }, (_, i) => `48${String(2 * i + 1).padStart(3, '0')}`);
const TEXAS_BOUNDS = { west: -106.65, south: 25.83, east: -93.5, north: 36.51 };

function parseCsv(text: string): CsvRow[] {
  const [header, ...rows] = text.trim().split('\n').map(parseCsvLine);
  return rows.map((cells) => Object.fromEntries(header.map((key, i) => [key, cells[i] ?? ''])));
}

function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (quoted && char === '"' && line[i + 1] === '"') {
      cell += '"';
      i += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === ',' && !quoted) {
      cells.push(cell);
      cell = '';
    } else {
      cell += char;
    }
  }
  return [...cells, cell];
}

function indexByGeoId(rows: CsvRow[]): Map<string, CsvRow> {
  return new Map(rows.map((row) => [row.GEO_ID, row]));
}

/** Census special values (negative codes), blanks and annotated cells are not estimates. */
function official(raw: string | undefined, annotation = ''): number | null {
  if (raw === undefined || raw.trim() === '' || annotation.trim() !== '') return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function polygonsOf(feature: CountyFeature): Position[][][] {
  const { geometry } = feature;
  return geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
}

function ringsOf(feature: CountyFeature): Position[][] {
  return polygonsOf(feature).flat();
}

/** Planar shoelace area in degrees²; negative means clockwise with north up. */
function signedArea(ring: Position[]): number {
  let area = 0;
  for (let i = 0; i < ring.length - 1; i += 1) area += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  return area / 2;
}

function orient(a: Position, b: Position, c: Position): number {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

function properlyCross(a: Position, b: Position, c: Position, d: Position): boolean {
  return orient(a, b, c) * orient(a, b, d) < 0 && orient(c, d, a) * orient(c, d, b) < 0;
}

function bbox(feature: CountyFeature): [number, number, number, number] {
  const points = ringsOf(feature).flat();
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

describe('income.json coverage', () => {
  it('lists exactly the 254 Texas counties by unique five-digit FIPS, in order', () => {
    const fips = atlas.counties.map((county) => county.fips);
    expect(new Set(fips).size).toBe(254);
    for (const code of fips) expect(code).toMatch(/^48\d{3}$/);
    expect(fips).toEqual(TEXAS_FIPS);
  });

  it('uses distinct official county names', () => {
    const names = atlas.counties.map((county) => county.name);
    expect(new Set(names).size).toBe(254);
    for (const name of names) expect(name).toMatch(/^\S.* County$/);
  });
});

describe('mean household income values', () => {
  it('stores only published values: whole positive dollars or null, never zero placeholders', () => {
    for (const county of atlas.counties) {
      if (county.meanIncome === null) {
        expect(county.marginOfError).toBeNull();
      } else {
        expect(Number.isInteger(county.meanIncome)).toBe(true);
        expect(county.meanIncome).toBeGreaterThan(0);
      }
      if (county.marginOfError !== null) expect(Number.isInteger(county.marginOfError) && county.marginOfError >= 0).toBe(true);
      if (county.households !== null) expect(Number.isInteger(county.households) && county.households > 0).toBe(true);
    }
  });

  it('matches the verbatim Census S1901 extract for every county, mapping special values to null', () => {
    expect(s1901.size).toBe(255);
    for (const county of atlas.counties) {
      const row = s1901.get(`0500000US${county.fips}`);
      expect(row, county.fips).toBeDefined();
      if (!row) continue;
      expect(row.NAME).toBe(`${county.name}, Texas`);
      const mean = official(row.S1901_C01_013E, row.S1901_C01_013EA);
      expect(county.meanIncome).toBe(mean);
      expect(county.marginOfError).toBe(mean === null ? null : official(row.S1901_C01_013M, row.S1901_C01_013MA));
      expect(county.households).toBe(official(row.S1901_C01_001E, row.S1901_C01_001EA));
    }
    expect(official('-666666666')).toBeNull();
    expect(official('-999999999')).toBeNull();
    expect(official('')).toBeNull();
    expect(official('85000', 'N')).toBeNull();
    expect(official('0')).toBe(0);
  });

  it('is the household mean: aggregate household income / households in the ACS summary file', () => {
    const geographies = [STATE_GEO_ID, ...atlas.counties.map((county) => `0500000US${county.fips}`)];
    for (const geoId of geographies) {
      const estimate = s1901.get(geoId);
      const check = summaryFile.get(geoId);
      expect(check, geoId).toBeDefined();
      if (!estimate || !check) continue;
      const households = official(check.B11001_E001);
      const aggregate = official(check.B19025_E001);
      const mean = official(estimate.S1901_C01_013E, estimate.S1901_C01_013EA);
      expect(official(estimate.S1901_C01_001E, estimate.S1901_C01_001EA), geoId).toBe(households);
      if (mean === null || aggregate === null || !households) continue;
      expect(Math.abs(aggregate / households - mean), geoId).toBeLessThanOrEqual(1);
    }
  });

  it('reports the official statewide estimate rather than an average of county estimates', () => {
    const state = s1901.get(STATE_GEO_ID);
    expect(state?.NAME).toBe('Texas');
    expect(atlas.stateMeanIncome).toBe(official(state?.S1901_C01_013E));
    expect(atlas.stateMarginOfError).toBe(official(state?.S1901_C01_013M));
    expect(atlas.stateMeanIncome).toBe(109933);
    expect(atlas.stateMarginOfError).toBe(385);

    const published = atlas.counties.filter((county) => county.meanIncome !== null && county.households !== null);
    expect(published).toHaveLength(254);
    const households = published.reduce((sum, county) => sum + (county.households ?? 0), 0);
    expect(households).toBe(official(state?.S1901_C01_001E));
    const weighted = published.reduce((sum, county) => sum + (county.meanIncome ?? 0) * (county.households ?? 0), 0) / households;
    const unweighted = published.reduce((sum, county) => sum + (county.meanIncome ?? 0), 0) / published.length;
    expect(Math.abs(weighted - 109933)).toBeLessThan(1);
    expect(Math.abs(unweighted - 109933)).toBeGreaterThan(10000);
  });

  it.each([
    ['48001', 'Anderson County', 82026, 8044, 17579],
    ['48029', 'Bexar County', 98061, 976, 750939],
    ['48201', 'Harris County', 111429, 920, 1757164],
    ['48453', 'Travis County', 143001, 1670, 583747],
    ['48301', 'Loving County', 64237, 26476, 27],
    ['48397', 'Rockwall County', 162868, 7334, 41237],
    ['48507', 'Zavala County', 50963, 7817, 3271],
  ])('spot-checks %s %s against the published 2020–2024 estimate', (fips, name, mean, moe, households) => {
    expect(atlas.counties.find((county) => county.fips === fips)).toEqual({
      fips, name, meanIncome: mean, marginOfError: moe, households,
    });
  });
});

describe('income.json metadata', () => {
  it('labels the release, dollar basis, variable, definition and boundaries', () => {
    const { metadata } = atlas;
    expect(metadata).toMatchObject({
      releaseYear: 2024,
      period: '2020–2024',
      dollarYear: 2024,
      sourceVariable: 'S1901_C01_013E',
      releaseDate: '2026-01-29',
      boundaryYear: 2024,
    });
    expect(metadata.source).toContain('Table S1901');
    expect(metadata.source).toContain('2024 Inflation-Adjusted Dollars');
    expect(metadata.sourceUrl).toMatch(/^https:\/\/data\.census\.gov\/table\/ACSST5Y2024\.S1901/);
    expect(metadata.boundaryUrl).toBe('https://www2.census.gov/geo/tiger/GENZ2024/shp/cb_2024_us_county_5m.zip');
    expect(Date.parse(metadata.fetchedAt)).toBeGreaterThanOrEqual(Date.parse(metadata.releaseDate));
    expect(metadata.definition).toMatch(/^Mean household income/);
    expect(metadata.notes).toMatch(/median/i);
    expect(metadata.notes).toMatch(/per-capita/i);
    expect(metadata.notes).toMatch(/90% confidence/);
    for (const value of Object.values(metadata)) expect(String(value)).not.toMatch(/undefined|NaN|None|null/);
  });
});

describe('texas-counties.geojson', () => {
  it('joins one-to-one with the income records by FIPS', () => {
    expect(collection.type).toBe('FeatureCollection');
    expect(features).toHaveLength(254);
    const names = new Map(atlas.counties.map((county) => [county.fips, county.name]));
    expect(features.map((feature) => feature.properties.fips)).toEqual(TEXAS_FIPS);
    for (const feature of features) {
      expect(Object.keys(feature.properties).sort()).toEqual(['fips', 'name']);
      expect(feature.properties.name).toBe(names.get(feature.properties.fips));
    }
  });

  it('has closed, finite, non-degenerate rings inside Texas', () => {
    for (const feature of features) {
      expect(['Polygon', 'MultiPolygon']).toContain(feature.geometry.type);
      for (const ring of ringsOf(feature)) {
        expect(ring.length).toBeGreaterThanOrEqual(4);
        expect(ring[0]).toEqual(ring[ring.length - 1]);
        expect(signedArea(ring)).not.toBe(0);
        ring.forEach(([lon, lat], i) => {
          expect(lon >= TEXAS_BOUNDS.west && lon <= TEXAS_BOUNDS.east, feature.properties.fips).toBe(true);
          expect(lat >= TEXAS_BOUNDS.south && lat <= TEXAS_BOUNDS.north, feature.properties.fips).toBe(true);
          if (i > 0) expect(ring[i]).not.toEqual(ring[i - 1]);
        });
      }
    }
  });

  it('uses d3-geo winding so each county is a small spherical polygon', () => {
    let total = 0;
    for (const feature of features) {
      for (const polygon of polygonsOf(feature)) {
        expect(signedArea(polygon[0])).toBeLessThan(0);
        for (const hole of polygon.slice(1)) expect(signedArea(hole)).toBeGreaterThan(0);
      }
      const area = geoArea(feature);
      expect(area, feature.properties.fips).toBeLessThan(0.001);
      total += area;
    }
    // Shoreline-clipped Texas is roughly 689,000 km² (Earth radius 6,371 km).
    expect(total * 6371.0088 ** 2).toBeGreaterThan(670000);
    expect(total * 6371.0088 ** 2).toBeLessThan(700000);
    const [[west, south], [east, north]] = geoBounds(collection);
    expect(west).toBeGreaterThanOrEqual(TEXAS_BOUNDS.west);
    expect(south).toBeGreaterThanOrEqual(TEXAS_BOUNDS.south);
    expect(east).toBeLessThanOrEqual(TEXAS_BOUNDS.east);
    expect(north).toBeLessThanOrEqual(TEXAS_BOUNDS.north);
  });

  it('has no crossing edges and shares identical borders between neighbours', () => {
    const segments: [Position, Position][] = [];
    const directed = new Set<string>();
    let repeated = 0;
    for (const feature of features) {
      for (const ring of ringsOf(feature)) {
        for (let i = 0; i < ring.length - 1; i += 1) {
          segments.push([ring[i], ring[i + 1]]);
          const key = `${ring[i].join()}>${ring[i + 1].join()}`;
          if (directed.has(key)) repeated += 1;
          directed.add(key);
        }
      }
    }
    expect(repeated).toBe(0);
    const shared = segments.filter(([a, b]) => directed.has(`${b.join()}>${a.join()}`)).length;
    expect(shared / segments.length).toBeGreaterThan(0.5);

    const cell = 0.25;
    const grid = new Map<string, number[]>();
    segments.forEach(([a, b], index) => {
      for (let x = Math.floor(Math.min(a[0], b[0]) / cell); x <= Math.floor(Math.max(a[0], b[0]) / cell); x += 1) {
        for (let y = Math.floor(Math.min(a[1], b[1]) / cell); y <= Math.floor(Math.max(a[1], b[1]) / cell); y += 1) {
          const key = `${x},${y}`;
          grid.set(key, [...(grid.get(key) ?? []), index]);
        }
      }
    });
    let crossings = 0;
    for (const members of grid.values()) {
      for (let i = 0; i < members.length; i += 1) {
        for (let j = i + 1; j < members.length; j += 1) {
          const [a, b] = segments[members[i]];
          const [c, d] = segments[members[j]];
          if (properlyCross(a, b, c, d)) crossings += 1;
        }
      }
    }
    expect(crossings).toBe(0);
  });

  it('never places a sampled point in two counties', () => {
    const boxes = features.map(bbox);
    let overlaps = 0;
    let covered = 0;
    for (let lon = TEXAS_BOUNDS.west + 0.0137; lon < TEXAS_BOUNDS.east; lon += 0.2371) {
      for (let lat = TEXAS_BOUNDS.south + 0.0091; lat < TEXAS_BOUNDS.north; lat += 0.2129) {
        const hits = features.filter((feature, i) => {
          const [x0, y0, x1, y1] = boxes[i];
          return lon >= x0 && lon <= x1 && lat >= y0 && lat <= y1 && geoContains(feature, [lon, lat]);
        }).length;
        if (hits > 1) overlaps += 1;
        if (hits === 1) covered += 1;
      }
    }
    expect(overlaps).toBe(0);
    expect(covered).toBeGreaterThan(1000);
  });

  it.each([
    ['Houston City Hall', -95.3698, 29.7604, '48201'],
    ['Texas State Capitol', -97.7404, 30.2747, '48453'],
    ['Dallas City Hall', -96.7969, 32.7763, '48113'],
    ['The Alamo', -98.4861, 29.426, '48029'],
    ['downtown Fort Worth', -97.3308, 32.7555, '48439'],
    ['Lubbock', -101.8552, 33.5779, '48303'],
    ['northeast El Paso', -106.4, 31.85, '48141'],
    ['central Loving County', -103.58, 31.84, '48301'],
    ['Galveston Island', -94.83, 29.28, '48167'],
    ['South Padre Island', -97.168, 26.112, '48061'],
  ])('places %s in exactly the right county', (_label, lon, lat, fips) => {
    const hits = features.filter((feature) => geoContains(feature, [lon, lat])).map((feature) => feature.properties.fips);
    expect(hits).toEqual([fips]);
  });
});
