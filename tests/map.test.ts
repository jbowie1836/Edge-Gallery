import { describe, expect, it } from 'vitest';
import type { MultiPolygon, Polygon } from 'geojson';
import type { GeoConicProjection } from 'd3-geo';
import type { CountyFeatureCollection, CountyIncome } from '../src/types';
import { getIncomeColor, getIncomeHeight, INCOME_STOPS, MISSING_COLOR } from '../src/lib/income';
import {
  buildMapLayout,
  convexHull,
  countyPathData,
  createTexasProjection,
  findCountyAt,
  interiorPoint,
  isCounterClockwiseFromAbove,
  MAP_SPAN,
  pointInCounty,
  pointInPolygon,
  signedArea,
  simplifyRing,
  type PlanarCounty,
  type PlanarPolygon,
  type PlanarRing,
} from '../src/components/map/projection';
import { buildBorderBuffers, buildExtrusion, buildOutlinePositions } from '../src/components/map/geometry';
import {
  DEFAULT_TILT,
  fitPose,
  interpolatePose,
  projectExtent,
  safeArea,
  TOP_DOWN_PHI,
  wrapAngle,
  type Insets,
} from '../src/components/map/camera';
import {
  countyDisplayName,
  displayHeight,
  encodeCounties,
  FLAT_HEIGHT,
  legendGradient,
  legendPosition,
  legendTicks,
} from '../src/components/map/encoding';
import { CITY_LABELS } from '../src/components/map/cities';

/**
 * Real county boundaries from the U.S. Census Bureau TIGERweb Generalized_ACS2023 service
 * (cartographic "Counties 20M" layer; Galveston from "Counties 5M" so its islands survive),
 * coordinates rounded to 4 decimals. The set spans the state's extremes: El Paso (west),
 * Orange (east), Dallam and Lipscomb (north), Cameron (south) and Brewster (Big Bend).
 */
const FIXTURE: CountyFeatureCollection = {
  type: 'FeatureCollection',
  features: [
  {"type":"Feature","properties":{"fips":"48029","name":"Bexar"},"geometry":{"type":"Polygon","coordinates":[[[-98.8066,29.6907],[-98.8048,29.2507],[-98.484,29.1407],[-98.4073,29.1144],[-98.1342,29.4418],[-98.1225,29.446],[-98.1226,29.478],[-98.3041,29.5847],[-98.3109,29.5945],[-98.3135,29.6023],[-98.3781,29.6626],[-98.3526,29.7344],[-98.4439,29.7197],[-98.4435,29.7345],[-98.5505,29.7607],[-98.6461,29.7452],[-98.6526,29.7499],[-98.7788,29.7202],[-98.8066,29.6907]]]}},
  {"type":"Feature","properties":{"fips":"48043","name":"Brewster"},"geometry":{"type":"Polygon","coordinates":[[[-103.8007,30.4125],[-103.7928,29.5002],[-103.7939,29.2592],[-103.789,29.2575],[-103.7247,29.1915],[-103.6602,29.1709],[-103.5924,29.1503],[-103.5246,29.121],[-103.4632,29.0668],[-103.362,29.0189],[-103.2812,28.9821],[-103.2278,28.9915],[-103.1267,28.9821],[-103.1004,29.0269],[-103.0764,29.0857],[-103.0357,29.103],[-102.9957,29.1612],[-102.9178,29.1907],[-102.8713,29.2416],[-102.891,29.2871],[-102.8719,29.3521],[-102.8246,29.3996],[-102.831,29.4443],[-102.8087,29.5223],[-102.7775,29.5565],[-102.7384,29.6219],[-102.6935,29.6765],[-102.6772,29.7383],[-102.6129,29.7482],[-102.5511,29.7524],[-102.5127,29.7803],[-102.4689,29.7798],[-102.3929,29.7656],[-102.3695,29.8204],[-102.3499,29.8623],[-102.3187,29.8722],[-102.327,29.8833],[-102.567,30.0528],[-103.44,30.6659],[-103.8007,30.4125]]]}},
  {"type":"Feature","properties":{"fips":"48061","name":"Cameron"},"geometry":{"type":"Polygon","coordinates":[[[-97.8619,26.3482],[-97.8623,26.0577],[-97.7953,26.0552],[-97.7588,26.0321],[-97.6971,26.0235],[-97.644,26.0066],[-97.5826,25.9379],[-97.543,25.92],[-97.4969,25.8801],[-97.4547,25.8793],[-97.4226,25.8404],[-97.3729,25.8401],[-97.3601,25.8689],[-97.366,25.9024],[-97.3383,25.9231],[-97.2772,25.9354],[-97.2069,25.9609],[-97.1566,25.949],[-97.1456,25.9711],[-97.1519,26.0177],[-97.1588,26.0827],[-97.1969,26.3059],[-97.2273,26.4112],[-97.3865,26.4104],[-97.447,26.3249],[-97.5069,26.3127],[-97.8619,26.3482]]]}},
  {"type":"Feature","properties":{"fips":"48111","name":"Dallam"},"geometry":{"type":"Polygon","coordinates":[[[-103.0419,36.5004],[-103.0408,36.0552],[-102.163,36.0552],[-102.1625,36.5003],[-103.0024,36.5004],[-103.0419,36.5004]]]}},
  {"type":"Feature","properties":{"fips":"48113","name":"Dallas"},"geometry":{"type":"Polygon","coordinates":[[[-97.0363,32.6932],[-97.0387,32.5487],[-96.5297,32.5453],[-96.5294,32.5453],[-96.5229,32.5645],[-96.519,32.8136],[-96.517,32.9829],[-96.6134,32.9843],[-96.6409,32.9847],[-96.7565,32.9863],[-96.8441,32.9874],[-96.91,32.9883],[-96.9399,32.9888],[-97.031,32.9897],[-97.0339,32.8365],[-97.0342,32.8167],[-97.0349,32.7799],[-97.0352,32.7597],[-97.0355,32.7395],[-97.036,32.7111],[-97.0363,32.6932]]]}},
  {"type":"Feature","properties":{"fips":"48141","name":"El Paso"},"geometry":{"type":"Polygon","coordinates":[[[-106.6234,31.914],[-106.6359,31.8715],[-106.5813,31.8139],[-106.5282,31.7831],[-106.4846,31.7478],[-106.4676,31.7596],[-106.4179,31.752],[-106.3701,31.7107],[-106.3399,31.6698],[-106.3035,31.6204],[-106.2808,31.5621],[-106.2368,31.5134],[-106.1757,31.4563],[-106.0803,31.3987],[-106.0049,31.3925],[-105.9964,31.3878],[-105.9543,31.4235],[-105.9933,31.4784],[-105.998,32.002],[-106.2007,32.0018],[-106.3772,32.0012],[-106.514,32.0008],[-106.6185,32.0005],[-106.6301,31.9713],[-106.6234,31.914]]]}},
  {"type":"Feature","properties":{"fips":"48201","name":"Harris"},"geometry":{"type":"Polygon","coordinates":[[[-95.9606,30.1636],[-95.8302,29.8004],[-95.826,29.7886],[-95.7304,29.7343],[-95.6883,29.7109],[-95.6871,29.7101],[-95.6232,29.6743],[-95.5971,29.6606],[-95.5714,29.6487],[-95.4243,29.5803],[-95.386,29.5856],[-95.3311,29.5991],[-95.2974,29.5965],[-95.2603,29.5899],[-95.2539,29.5538],[-95.2163,29.5558],[-95.1616,29.4973],[-95.0683,29.5575],[-95.0182,29.5546],[-95.015,29.6319],[-94.9138,29.7663],[-94.9087,29.8261],[-94.9815,29.8843],[-94.9987,29.9198],[-94.9859,29.973],[-95.0309,29.9937],[-95.0967,30.1672],[-95.293,30.0279],[-95.4242,30.1155],[-95.4911,30.1104],[-95.4998,30.1425],[-95.5421,30.1705],[-95.5746,30.1518],[-95.5968,30.1345],[-95.6232,30.1356],[-95.7552,30.0921],[-95.8033,30.0901],[-95.9606,30.1636]]]}},
  {"type":"Feature","properties":{"fips":"48295","name":"Lipscomb"},"geometry":{"type":"Polygon","coordinates":[[[-100.5461,36.4995],[-100.5467,36.0565],[-100.5402,36.0565],[-100.0004,36.0557],[-100.0004,36.4997],[-100.0038,36.4997],[-100.311,36.4997],[-100.5461,36.4995]]]}},
  {"type":"Feature","properties":{"fips":"48361","name":"Orange"},"geometry":{"type":"Polygon","coordinates":[[[-94.1176,30.2417],[-94.0912,30.2046],[-94.1159,30.1603],[-94.0737,30.1141],[-94.094,30.0863],[-94.032,30.028],[-93.8439,29.9548],[-93.8523,29.8721],[-93.8304,29.8944],[-93.8078,29.9545],[-93.7411,30.0216],[-93.7062,30.0523],[-93.7039,30.0543],[-93.7024,30.1127],[-93.7038,30.1739],[-93.7134,30.2253],[-93.7111,30.244],[-93.9015,30.2427],[-94.1176,30.2417]]]}},
  {"type":"Feature","properties":{"fips":"48453","name":"Travis"},"geometry":{"type":"Polygon","coordinates":[[[-98.1256,30.4262],[-98.173,30.3563],[-98.0108,30.2403],[-97.9288,30.1817],[-97.8139,30.0991],[-97.8135,30.0988],[-97.7088,30.0235],[-97.6494,30.0679],[-97.4913,30.2121],[-97.4863,30.2205],[-97.4001,30.3679],[-97.3695,30.4196],[-97.5962,30.5015],[-97.6738,30.4801],[-97.6841,30.4763],[-97.6946,30.4615],[-97.7211,30.4558],[-97.7337,30.4497],[-97.7467,30.4494],[-97.7547,30.4402],[-97.7536,30.4333],[-97.7763,30.4298],[-97.7794,30.4384],[-97.7997,30.4471],[-97.8119,30.447],[-97.8257,30.4556],[-97.8465,30.4734],[-97.8679,30.5465],[-97.9567,30.6282],[-98.0499,30.6242],[-98.1234,30.4865],[-98.1256,30.4262]]]}},
  {"type":"Feature","properties":{"fips":"48167","name":"Galveston"},"geometry":{"type":"MultiPolygon","coordinates":[[[[-95.2317,29.4726],[-95.2298,29.4607],[-95.2093,29.43],[-95.1959,29.4095],[-95.1922,29.4044],[-95.1835,29.3912],[-95.1468,29.3365],[-95.1197,29.2958],[-95.0587,29.2032],[-95.0225,29.2297],[-94.9832,29.2636],[-94.9525,29.2901],[-94.9517,29.2899],[-94.9278,29.2833],[-94.9216,29.2816],[-94.9041,29.2984],[-94.8987,29.3036],[-94.894,29.3082],[-94.8942,29.338],[-94.8865,29.3664],[-94.8875,29.3844],[-94.888,29.3937],[-94.8887,29.4074],[-94.8891,29.415],[-94.8902,29.4219],[-94.8921,29.4334],[-94.9178,29.4446],[-94.9186,29.445],[-94.919,29.4453],[-94.9516,29.4665],[-94.9514,29.4672],[-94.9495,29.4756],[-94.9352,29.4812],[-94.9234,29.4769],[-94.9136,29.4876],[-94.9095,29.4968],[-94.9584,29.505],[-94.9593,29.5052],[-94.9745,29.5092],[-94.9819,29.5111],[-94.9906,29.516],[-94.9996,29.5211],[-95.0152,29.54],[-95.0182,29.5546],[-95.0231,29.5494],[-95.0354,29.5531],[-95.0501,29.5585],[-95.0572,29.5591],[-95.0643,29.5588],[-95.069,29.5564],[-95.0783,29.5473],[-95.0796,29.5344],[-95.0923,29.5343],[-95.0963,29.5352],[-95.0981,29.5183],[-95.1024,29.5214],[-95.1055,29.5103],[-95.1172,29.5081],[-95.1229,29.5105],[-95.1607,29.4975],[-95.1675,29.5125],[-95.1788,29.518],[-95.1863,29.5234],[-95.1951,29.5436],[-95.1972,29.542],[-95.1977,29.5573],[-95.1932,29.5595],[-95.201,29.5632],[-95.2163,29.5558],[-95.2191,29.5412],[-95.2233,29.5176],[-95.2317,29.4726]]],[[[-94.7831,29.3756],[-94.7824,29.3643],[-94.7787,29.3615],[-94.7615,29.3619],[-94.7448,29.3692],[-94.731,29.3691],[-94.724,29.3833],[-94.7085,29.403],[-94.6942,29.4156],[-94.6704,29.4308],[-94.6311,29.4515],[-94.5949,29.4679],[-94.4998,29.507],[-94.3708,29.5564],[-94.3718,29.5972],[-94.3885,29.5957],[-94.3988,29.5945],[-94.4098,29.5967],[-94.4128,29.5726],[-94.4705,29.557],[-94.4663,29.5523],[-94.488,29.529],[-94.5271,29.5131],[-94.546,29.5225],[-94.5551,29.5282],[-94.5657,29.5301],[-94.5793,29.5234],[-94.5944,29.5058],[-94.5942,29.4921],[-94.6086,29.4833],[-94.6282,29.476],[-94.6459,29.4738],[-94.6567,29.478],[-94.6659,29.4784],[-94.6724,29.4768],[-94.6815,29.4714],[-94.6864,29.4665],[-94.7064,29.4368],[-94.7238,29.4265],[-94.7541,29.401],[-94.7668,29.3935],[-94.7831,29.3756]]],[[[-95.1299,29.0856],[-95.1193,29.0778],[-95.1145,29.0835],[-95.1105,29.0882],[-95.0818,29.1112],[-95.0262,29.1481],[-94.9819,29.1742],[-94.9475,29.1945],[-94.8687,29.2409],[-94.8444,29.2553],[-94.822,29.2684],[-94.8191,29.2701],[-94.8037,29.2792],[-94.7861,29.2907],[-94.7697,29.3049],[-94.7348,29.326],[-94.7344,29.3321],[-94.7391,29.335],[-94.7727,29.3366],[-94.7771,29.3368],[-94.78,29.3349],[-94.7849,29.3355],[-94.8107,29.3534],[-94.8223,29.3443],[-94.8225,29.3219],[-94.825,29.306],[-94.8497,29.2973],[-94.8651,29.294],[-94.8733,29.2893],[-94.8792,29.2858],[-94.8856,29.281],[-94.9519,29.2311],[-94.9915,29.2011],[-94.992,29.2005],[-95.0039,29.1845],[-95.0986,29.1288],[-95.1056,29.123],[-95.1299,29.0856]]]]}},
  ],
};

const layout = buildMapLayout(FIXTURE, { simplifyTolerance: 0 });
const countyByFips = new Map(layout.counties.map((county) => [county.fips, county]));

function county(fips: string): PlanarCounty {
  const found = countyByFips.get(fips);
  if (!found) throw new Error(`fixture county ${fips} missing`);
  return found;
}

function reverseRings(geometry: Polygon | MultiPolygon): Polygon | MultiPolygon {
  if (geometry.type === 'Polygon') return { type: 'Polygon', coordinates: geometry.coordinates.map((ring) => [...ring].reverse()) };
  return { type: 'MultiPolygon', coordinates: geometry.coordinates.map((polygon) => polygon.map((ring) => [...ring].reverse())) };
}

function rings(polygon: PlanarPolygon): PlanarRing[] {
  return [polygon.outer, ...polygon.holes];
}

function triangleArea(positions: Float32Array, a: number, b: number, c: number): number {
  const ax = positions[a * 3];
  const az = positions[a * 3 + 2];
  const bx = positions[b * 3];
  const bz = positions[b * 3 + 2];
  const cx = positions[c * 3];
  const cz = positions[c * 3 + 2];
  return Math.abs((bx - ax) * (cz - az) - (bz - az) * (cx - ax)) / 2;
}

/** y component of (B - A) × (C - A), i.e. the facing of a cap triangle. */
function triangleNormalY(positions: Float32Array, a: number, b: number, c: number): number {
  const ax = positions[a * 3];
  const az = positions[a * 3 + 2];
  return (positions[b * 3 + 2] - az) * (positions[c * 3] - ax) - (positions[b * 3] - ax) * (positions[c * 3 + 2] - az);
}

describe('Texas projection and planar layout', () => {
  it('uses Texas Centric Albers Equal Area parameters', () => {
    const projection = createTexasProjection() as GeoConicProjection;
    expect(projection.parallels()).toEqual([27.5, 35]);
    expect(projection.rotate()).toEqual([100, 0, 0]);
    // The central meridian projects onto x = 0 and latitude increases toward -y (north up).
    expect(projection([-100, 31])![0]).toBeCloseTo(0, 12);
    expect(projection([-100, 33])![1]).toBeLessThan(projection([-100, 29])![1]);
  });

  it('centers the state and scales its larger dimension to the map span', () => {
    const { minX, maxX, minZ, maxZ } = layout.bounds;
    expect(Math.max(maxX - minX, maxZ - minZ)).toBeCloseTo(MAP_SPAN, 9);
    expect((minX + maxX) / 2).toBeCloseTo(0, 9);
    expect((minZ + maxZ) / 2).toBeCloseTo(0, 9);
    expect(layout.counties).toHaveLength(FIXTURE.features.length);
  });

  it('keeps geographic orientation: east is +x and north is -z', () => {
    expect(county('48141').bounds.minX).toBeCloseTo(layout.bounds.minX, 9); // El Paso is the western tip
    expect(county('48361').bounds.maxX).toBeCloseTo(layout.bounds.maxX, 9); // Orange is the eastern edge
    expect(county('48061').bounds.maxZ).toBeCloseTo(layout.bounds.maxZ, 9); // Cameron is the southern tip
    expect(Math.min(county('48111').bounds.minZ, county('48295').bounds.minZ)).toBeCloseTo(layout.bounds.minZ, 9);
    expect(county('48111').labelPoint[0]).toBeLessThan(county('48295').labelPoint[0]); // Dallam west of Lipscomb
  });

  it('normalizes ring winding regardless of the input convention', () => {
    const reversed = buildMapLayout(
      { ...FIXTURE, features: FIXTURE.features.map((feature) => ({ ...feature, geometry: reverseRings(feature.geometry) })) },
      { simplifyTolerance: 0 },
    );
    for (const candidate of [layout, reversed]) {
      for (const entry of candidate.counties) {
        for (const polygon of entry.polygons) {
          expect(isCounterClockwiseFromAbove(polygon.outer)).toBe(true);
          for (const hole of polygon.holes) expect(isCounterClockwiseFromAbove(hole)).toBe(false);
        }
      }
    }
    for (const entry of reversed.counties) expect(entry.area).toBeCloseTo(county(entry.fips).area, 9);
  });

  it('preserves every part of a real multipolygon county', () => {
    const galveston = county('48167');
    expect(galveston.polygons).toHaveLength(3);
    const sum = galveston.polygons.reduce((total, polygon) => total + Math.abs(signedArea(polygon.outer)), 0);
    expect(galveston.area).toBeCloseTo(sum, 9);
    expect(pointInCounty(galveston.labelPoint, galveston)).toBe(true);
  });

  it('drops closing duplicates so rings are open', () => {
    for (const entry of layout.counties) {
      for (const polygon of entry.polygons) {
        for (const ring of rings(polygon)) {
          const first = ring[0];
          const last = ring[ring.length - 1];
          expect(first[0] === last[0] && first[1] === last[1]).toBe(false);
        }
      }
    }
  });

  it('places the Census city points inside their counties', () => {
    const expected: Record<string, string> = {
      Dallas: '48113',
      Houston: '48201',
      Austin: '48453',
      'San Antonio': '48029',
      'El Paso': '48141',
    };
    for (const city of CITY_LABELS) {
      const point = layout.project(city.lon, city.lat);
      expect(point).not.toBeNull();
      expect(findCountyAt(layout, point!)?.fips).toBe(expected[city.name]);
    }
  });

  it('finds interior label points even for concave shapes', () => {
    for (const entry of layout.counties) expect(pointInCounty(entry.labelPoint, entry)).toBe(true);
    // A U shape whose centroid falls in the empty notch.
    const cup: PlanarPolygon = {
      outer: [[0, 0], [3, 0], [3, -3], [2, -3], [2, -1], [1, -1], [1, -3], [0, -3]],
      holes: [],
    };
    expect(isCounterClockwiseFromAbove(cup.outer)).toBe(true);
    expect(pointInPolygon(interiorPoint(cup), cup)).toBe(true);
  });

  it('builds closed SVG paths for the flat fallback map', () => {
    const galveston = county('48167');
    const path = countyPathData(galveston);
    expect(path.match(/M/g)).toHaveLength(galveston.polygons.reduce((n, polygon) => n + rings(polygon).length, 0));
    expect(path.endsWith('Z')).toBe(true);
  });
});

describe('ring simplification', () => {
  it('never moves the outline by more than the tolerance', () => {
    const dense = buildMapLayout(FIXTURE, { simplifyTolerance: 0 });
    const outer = dense.counties.find((entry) => entry.fips === '48167')!.polygons[0].outer;
    const tolerance = 0.02;
    const simplified = simplifyRing(outer, tolerance);
    expect(simplified.length).toBeGreaterThanOrEqual(3);
    expect(simplified.length).toBeLessThan(outer.length);
    const segmentDistance = (p: number[], a: number[], b: number[]) => {
      const dx = b[0] - a[0];
      const dz = b[1] - a[1];
      const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / (dx * dx + dz * dz || 1)));
      return Math.hypot(p[0] - (a[0] + dx * t), p[1] - (a[1] + dz * t));
    };
    for (const point of outer) {
      let best = Infinity;
      for (let i = 0; i < simplified.length; i++) {
        best = Math.min(best, segmentDistance(point, simplified[i], simplified[(i + 1) % simplified.length]));
      }
      expect(best).toBeLessThanOrEqual(tolerance + 1e-9);
    }
  });

  it('keeps small rings untouched', () => {
    const triangle: PlanarRing = [[0, 0], [1, 0], [0, -1]];
    expect(simplifyRing(triangle, 10)).toBe(triangle);
  });
});

describe('extruded county geometry', () => {
  const holed: PlanarPolygon = {
    outer: [[0, 0], [4, 0], [4, -4], [0, -4]],
    holes: [[[1, -1], [1, -3], [3, -3], [3, -1]]],
  };

  function checkExtrusion(polygons: PlanarPolygon[], expectedArea: number) {
    const data = buildExtrusion(polygons);
    const ringVertices = polygons.reduce((n, polygon) => n + rings(polygon).reduce((m, ring) => m + ring.length, 0), 0);
    const expectedTriangles = polygons.reduce(
      (n, polygon) => n + rings(polygon).reduce((m, ring) => m + ring.length, 0) + 2 * polygon.holes.length - 2,
      0,
    );
    expect(data.positions.length).toBe(ringVertices * 5 * 3);
    expect(data.topIndexCount).toBe(expectedTriangles * 3);
    expect(data.wallIndexCount).toBe(ringVertices * 6);

    let capArea = 0;
    for (let i = 0; i < data.topIndexCount; i += 3) {
      const [a, b, c] = [data.indices[i], data.indices[i + 1], data.indices[i + 2]];
      expect(triangleNormalY(data.positions, a, b, c)).toBeGreaterThanOrEqual(0);
      expect(data.positions[a * 3 + 1]).toBe(1);
      capArea += triangleArea(data.positions, a, b, c);
    }
    expect(Math.abs(capArea - expectedArea) / expectedArea).toBeLessThan(1e-6);

    // Every wall faces outward: stepping along its normal leaves the solid.
    const solid = (x: number, z: number) => polygons.some((polygon) => pointInPolygon([x, z], polygon));
    for (let i = data.topIndexCount; i < data.indices.length; i += 6) {
      const v0 = data.indices[i];
      const v1 = data.indices[i + 1];
      const v2 = data.indices[i + 2];
      const p = data.positions;
      const n = data.normals;
      const edgeX = p[v1 * 3] - p[v0 * 3];
      const edgeZ = p[v1 * 3 + 2] - p[v0 * 3 + 2];
      const length = Math.hypot(edgeX, edgeZ);
      // Front-face winding agrees with the stored normal.
      const ux = p[v1 * 3] - p[v0 * 3];
      const uy = p[v1 * 3 + 1] - p[v0 * 3 + 1];
      const uz = p[v1 * 3 + 2] - p[v0 * 3 + 2];
      const wx = p[v2 * 3] - p[v0 * 3];
      const wy = p[v2 * 3 + 1] - p[v0 * 3 + 1];
      const wz = p[v2 * 3 + 2] - p[v0 * 3 + 2];
      const cross = [uy * wz - uz * wy, uz * wx - ux * wz, ux * wy - uy * wx];
      expect(cross[0] * n[v0 * 3] + cross[1] * n[v0 * 3 + 1] + cross[2] * n[v0 * 3 + 2]).toBeGreaterThan(0);
      if (length < 1e-3) continue;
      const mx = p[v0 * 3] + edgeX / 2;
      const mz = p[v0 * 3 + 2] + edgeZ / 2;
      const step = Math.min(length * 0.05, 1e-4);
      expect(solid(mx + n[v0 * 3] * step, mz + n[v0 * 3 + 2] * step)).toBe(false);
      expect(solid(mx - n[v0 * 3] * step, mz - n[v0 * 3 + 2] * step)).toBe(true);
    }
  }

  it('triangulates holes and keeps hole walls facing into the hole', () => {
    checkExtrusion([holed], 16 - 4);
  });

  it('builds outward-facing prisms for real single and multipolygon counties', () => {
    for (const entry of layout.counties) checkExtrusion(entry.polygons, entry.area);
  });

  it('builds outline segments for highlights and merged borders', () => {
    const travis = county('48453');
    const outline = buildOutlinePositions(travis.polygons, 1);
    expect(outline.length).toBe(travis.polygons[0].outer.length * 6);
    expect(outline[1]).toBe(1);
    const borders = buildBorderBuffers([
      { polygons: travis.polygons, height: 2.5 },
      { polygons: [holed], height: 0.025 },
    ]);
    expect(borders.positions.length).toBe(borders.heights.length * 3);
    expect(borders.heights[0]).toBe(2.5);
    expect(borders.heights[borders.heights.length - 1]).toBeCloseTo(0.025, 6);
  });
});

describe('camera framing', () => {
  const heights = new Map([
    ['48453', getIncomeHeight(150000)],
    ['48201', getIncomeHeight(110000)],
  ]);
  const points: number[] = [];
  for (const [x, z] of layout.hull) points.push(x, 0, z);
  for (const entry of layout.counties) {
    const h = heights.get(entry.fips) ?? getIncomeHeight(60000);
    const { minX, maxX, minZ, maxZ } = entry.bounds;
    points.push(minX, h, minZ, maxX, h, minZ, maxX, h, maxZ, minX, h, maxZ);
  }

  const insetCases: Insets[] = [
    { top: 0.04, right: 0.08, bottom: 0.07, left: 0.03 },
    { top: 0.12, right: 0.14, bottom: 0.22, left: 0.03 },
  ];

  for (const aspect of [0.55, 0.85, 1, 1.5, 2.4]) {
    for (const phi of [TOP_DOWN_PHI, DEFAULT_TILT]) {
      for (const insets of insetCases) {
        it(`fits the whole state tightly and centered (aspect ${aspect}, tilt ${Math.round((phi * 180) / Math.PI)}°)`, () => {
          const pose = fitPose(points, { phi, theta: 0, aspect, insets });
          const extent = projectExtent(points, pose, 30, aspect)!;
          const safe = safeArea(insets);
          expect(extent).not.toBeNull();
          expect(extent.minX).toBeGreaterThanOrEqual(safe.minX - 1e-6);
          expect(extent.maxX).toBeLessThanOrEqual(safe.maxX + 1e-6);
          expect(extent.minY).toBeGreaterThanOrEqual(safe.minY - 1e-6);
          expect(extent.maxY).toBeLessThanOrEqual(safe.maxY + 1e-6);
          // Tight: the footprint fills the safe area along at least one axis.
          const fillX = (extent.maxX - extent.minX) / (safe.maxX - safe.minX);
          const fillY = (extent.maxY - extent.minY) / (safe.maxY - safe.minY);
          expect(Math.max(fillX, fillY)).toBeGreaterThan(0.99);
          // Centered within the safe area.
          expect(Math.abs((extent.minX + extent.maxX) / 2 - (safe.minX + safe.maxX) / 2)).toBeLessThan(0.01);
          expect(Math.abs((extent.minY + extent.maxY) / 2 - (safe.minY + safe.maxY) / 2)).toBeLessThan(0.01);
          expect(pose.target.y).toBe(0);
        });
      }
    }
  }

  it('interpolates bearings the short way around', () => {
    const from = fitPose(points, { phi: DEFAULT_TILT, theta: (170 * Math.PI) / 180, aspect: 1.5, insets: insetCases[0] });
    const to = { ...from, target: from.target.clone(), theta: (-170 * Math.PI) / 180 };
    const mid = interpolatePose(from, to, 0.5);
    expect(Math.abs(wrapAngle(mid.theta))).toBeCloseTo(Math.PI, 6);
    expect(interpolatePose(from, to, 1).radius).toBeCloseTo(from.radius, 9);
  });

  it('uses a convex footprint for framing', () => {
    expect(layout.hull.length).toBeGreaterThan(3);
    expect(convexHull([[0, 0], [1, 0], [1, 1], [0, 1], [0.5, 0.5]])).toHaveLength(4);
  });
});

describe('income encoding and FIPS join', () => {
  const records: CountyIncome[] = [
    { fips: '48453', name: 'Travis County', meanIncome: 100000, marginOfError: 1200, households: 500000 },
    { fips: '48201', name: 'Harris County', meanIncome: 50000, marginOfError: 900, households: 1700000 },
    { fips: '48301', name: 'Loving County', meanIncome: null, marginOfError: null, households: 40 },
    { fips: '48029', name: 'Bexar County', meanIncome: 0, marginOfError: null, households: null },
  ];
  const boundaries = [...layout.counties.map(({ fips, name }) => ({ fips, name })), { fips: '48301', name: 'Loving' }];
  const encodings = encodeCounties(boundaries, records);

  it('joins on FIPS and uses the shared color and height helpers exactly', () => {
    const travis = encodings.get('48453')!;
    expect(travis.income).toBe(100000);
    expect(travis.color).toBe(getIncomeColor(100000));
    expect(travis.height).toBe(getIncomeHeight(100000));
    expect(travis.displayName).toBe('Travis County');
    expect(encodings.get('48201')!.color).toBe(getIncomeColor(50000));
  });

  it('keeps missing estimates distinct from zero', () => {
    const unmatched = encodings.get('48111')!; // Dallam has no record in this join
    expect(unmatched.income).toBeNull();
    expect(unmatched.unmatched).toBe(true);
    expect(unmatched.color).toBe(MISSING_COLOR);

    const suppressed = encodings.get('48301')!;
    expect(suppressed.income).toBeNull();
    expect(suppressed.unmatched).toBe(false);
    expect(suppressed.color).toBe(MISSING_COLOR);
    expect(suppressed.households).toBe(40);

    const zero = encodings.get('48029')!;
    expect(zero.income).toBe(0);
    expect(zero.color).not.toBe(MISSING_COLOR);
  });

  it('extrudes heights in proportion to income and flattens in 2D', () => {
    const travis = encodings.get('48453')!;
    const harris = encodings.get('48201')!;
    expect(displayHeight(travis.height, 1) / displayHeight(harris.height, 1)).toBeCloseTo(2, 12);
    expect(displayHeight(travis.height, 0)).toBe(FLAT_HEIGHT);
    expect(displayHeight(getIncomeHeight(null), 1)).toBeGreaterThanOrEqual(FLAT_HEIGHT);
  });

  it('formats county names consistently', () => {
    expect(countyDisplayName('Travis')).toBe('Travis County');
    expect(countyDisplayName('Travis County')).toBe('Travis County');
    expect(countyDisplayName('Travis County, Texas')).toBe('Travis County');
  });
});

describe('legend', () => {
  it('labels every shared color stop in dollars with clamped ends', () => {
    const ticks = legendTicks();
    expect(ticks.map((tick) => tick.label)).toEqual(['≤$40k', '$80k', '$120k', '$160k', '$200k+']);
    expect(ticks.map((tick) => tick.offset)).toEqual([0, 0.25, 0.5, 0.75, 1]);
    expect(ticks.map((tick) => tick.value)).toEqual(INCOME_STOPS.map((stop) => stop.value));
  });

  it('draws a gradient whose stops match getIncomeColor', () => {
    const gradient = legendGradient();
    for (const tick of legendTicks()) {
      expect(gradient).toContain(`${getIncomeColor(tick.value)} ${(tick.offset * 100).toFixed(2)}%`);
    }
  });

  it('positions values on the legend and leaves missing values off it', () => {
    expect(legendPosition(120000)).toBe(0.5);
    expect(legendPosition(10000)).toBe(0);
    expect(legendPosition(500000)).toBe(1);
    expect(legendPosition(null)).toBeNull();
  });
});
