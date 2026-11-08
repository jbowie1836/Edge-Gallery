import { geoConicEqualArea, type GeoProjection } from 'd3-geo';
import type { MultiPolygon, Polygon, Position } from 'geojson';
import type { CountyFeatureCollection } from '../../types';

/**
 * Planar map coordinates on the three.js ground plane: x grows east and z grows south,
 * so north is -z and a camera on the +z side sees the map north-up.
 */
export type PlanarPoint = [x: number, z: number];
export type PlanarRing = PlanarPoint[];

export interface PlanarPolygon {
  /** Exterior ring, counter-clockwise when viewed from above (north up). Open: no repeated end point. */
  outer: PlanarRing;
  /** Holes, clockwise when viewed from above. */
  holes: PlanarRing[];
}

export interface Bounds {
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
}

export interface PlanarCounty {
  fips: string;
  name: string;
  polygons: PlanarPolygon[];
  bounds: Bounds;
  area: number;
  /** A point guaranteed to sit inside the county's largest polygon. */
  labelPoint: PlanarPoint;
}

export interface MapLayout {
  counties: PlanarCounty[];
  bounds: Bounds;
  /** Convex hull of the whole state footprint. */
  hull: PlanarPoint[];
  span: number;
  vertexCount: number;
  /** Projects longitude/latitude into the same planar frame as the counties. */
  project: (lon: number, lat: number) => PlanarPoint | null;
}

export interface LayoutOptions {
  /** World units across the larger dimension of the state. */
  span?: number;
  /** Douglas–Peucker tolerance in world units; 0 keeps every vertex. */
  simplifyTolerance?: number;
}

export const MAP_SPAN = 40;
/** ≈47 m on the ground: well below a pixel even at maximum zoom, but trims dense coastlines. */
export const DEFAULT_SIMPLIFY_TOLERANCE = 0.0015;

const EMPTY_BOUNDS: Bounds = { minX: 0, minZ: 0, maxX: 0, maxZ: 0 };

/** Texas Centric Albers Equal Area (EPSG:3083): standard parallels 27.5°N/35°N, central meridian 100°W. */
export function createTexasProjection(): GeoProjection {
  return geoConicEqualArea().parallels([27.5, 35]).rotate([100, 0]).scale(1).translate([0, 0]);
}

/** Shoelace area in (x, z). Negative means counter-clockwise when viewed from above with north up. */
export function signedArea(ring: PlanarRing): number {
  let sum = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    sum += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  }
  return sum / 2;
}

export function isCounterClockwiseFromAbove(ring: PlanarRing): boolean {
  return signedArea(ring) < 0;
}

export function pointInRing(point: PlanarPoint, ring: PlanarRing): boolean {
  const [x, z] = point;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i];
    const [xj, zj] = ring[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

export function pointInPolygon(point: PlanarPoint, polygon: PlanarPolygon): boolean {
  return pointInRing(point, polygon.outer) && !polygon.holes.some((hole) => pointInRing(point, hole));
}

export function pointInCounty(point: PlanarPoint, county: PlanarCounty): boolean {
  const { bounds } = county;
  if (point[0] < bounds.minX || point[0] > bounds.maxX || point[1] < bounds.minZ || point[1] > bounds.maxZ) return false;
  return county.polygons.some((polygon) => pointInPolygon(point, polygon));
}

export function findCountyAt(layout: MapLayout, point: PlanarPoint): PlanarCounty | null {
  return layout.counties.find((county) => pointInCounty(point, county)) ?? null;
}

function squaredSegmentDistance(p: PlanarPoint, a: PlanarPoint, b: PlanarPoint): number {
  let x = a[0];
  let z = a[1];
  let dx = b[0] - x;
  let dz = b[1] - z;
  if (dx !== 0 || dz !== 0) {
    const t = ((p[0] - x) * dx + (p[1] - z) * dz) / (dx * dx + dz * dz);
    if (t > 1) {
      x = b[0];
      z = b[1];
    } else if (t > 0) {
      x += dx * t;
      z += dz * t;
    }
  }
  dx = p[0] - x;
  dz = p[1] - z;
  return dx * dx + dz * dz;
}

/** Douglas–Peucker for a closed ring, anchored on vertex 0 and the vertex farthest from it. */
export function simplifyRing(ring: PlanarRing, tolerance: number): PlanarRing {
  const n = ring.length;
  if (tolerance <= 0 || n <= 8) return ring;
  const squaredTolerance = tolerance * tolerance;
  let far = 0;
  let farDistance = -1;
  for (let i = 1; i < n; i++) {
    const dx = ring[i][0] - ring[0][0];
    const dz = ring[i][1] - ring[0][1];
    const distance = dx * dx + dz * dz;
    if (distance > farDistance) {
      farDistance = distance;
      far = i;
    }
  }
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[far] = 1;
  // Index n stands for vertex 0 so the second half closes the ring.
  const stack = [0, far, far, n];
  while (stack.length > 0) {
    const last = stack.pop()!;
    const first = stack.pop()!;
    const a = ring[first % n];
    const b = ring[last % n];
    let maxDistance = 0;
    let index = -1;
    for (let i = first + 1; i < last; i++) {
      const distance = squaredSegmentDistance(ring[i], a, b);
      if (distance > maxDistance) {
        maxDistance = distance;
        index = i;
      }
    }
    if (index !== -1 && maxDistance > squaredTolerance) {
      keep[index] = 1;
      stack.push(first, index, index, last);
    }
  }
  const simplified: PlanarRing = [];
  for (let i = 0; i < n; i++) if (keep[i]) simplified.push(ring[i]);
  return simplified.length >= 3 ? simplified : ring;
}

/** Andrew's monotone chain; returns the hull counter-clockwise in (x, z). */
export function convexHull(points: PlanarPoint[]): PlanarPoint[] {
  const sorted = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (sorted.length <= 2) return sorted;
  const cross = (o: PlanarPoint, a: PlanarPoint, b: PlanarPoint) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: PlanarPoint[] = [];
  for (const point of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], point) <= 0) lower.pop();
    lower.push(point);
  }
  const upper: PlanarPoint[] = [];
  for (let i = sorted.length - 1; i >= 0; i--) {
    const point = sorted[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], point) <= 0) upper.pop();
    upper.push(point);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

export function ringCentroid(ring: PlanarRing): PlanarPoint {
  let area = 0;
  let cx = 0;
  let cz = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const cross = ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
    area += cross;
    cx += (ring[j][0] + ring[i][0]) * cross;
    cz += (ring[j][1] + ring[i][1]) * cross;
  }
  if (Math.abs(area) < 1e-12) {
    const sum = ring.reduce((acc, [x, z]) => [acc[0] + x, acc[1] + z], [0, 0]);
    return [sum[0] / ring.length, sum[1] / ring.length];
  }
  return [cx / (3 * area), cz / (3 * area)];
}

function polygonArea(polygon: PlanarPolygon): number {
  return Math.abs(signedArea(polygon.outer)) - polygon.holes.reduce((sum, hole) => sum + Math.abs(signedArea(hole)), 0);
}

/**
 * Label anchor inside the polygon: the centroid when it is inside, otherwise the midpoint of the
 * widest horizontal interior span on a few scanlines (handles concave and holed shapes).
 */
export function interiorPoint(polygon: PlanarPolygon): PlanarPoint {
  const centroid = ringCentroid(polygon.outer);
  if (pointInPolygon(centroid, polygon)) return centroid;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const [, z] of polygon.outer) {
    minZ = Math.min(minZ, z);
    maxZ = Math.max(maxZ, z);
  }
  const rings = [polygon.outer, ...polygon.holes];
  let best: { x: number; z: number; width: number } | null = null;
  const scanlines = [centroid[1], ...[0.5, 0.35, 0.65, 0.2, 0.8].map((t) => minZ + (maxZ - minZ) * t)];
  for (const z of scanlines) {
    const crossings: number[] = [];
    for (const ring of rings) {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, zi] = ring[i];
        const [xj, zj] = ring[j];
        if (zi > z !== zj > z) crossings.push(xi + ((z - zi) * (xj - xi)) / (zj - zi));
      }
    }
    crossings.sort((a, b) => a - b);
    for (let k = 0; k + 1 < crossings.length; k += 2) {
      const width = crossings[k + 1] - crossings[k];
      if (!best || width > best.width) best = { x: (crossings[k] + crossings[k + 1]) / 2, z, width };
    }
  }
  return best ? [best.x, best.z] : centroid;
}

function polygonsOf(geometry: Polygon | MultiPolygon | null | undefined): Position[][][] {
  if (!geometry) return [];
  if (geometry.type === 'Polygon') return [geometry.coordinates];
  if (geometry.type === 'MultiPolygon') return geometry.coordinates;
  return [];
}

function cleanRing(points: PlanarPoint[]): PlanarRing {
  const ring: PlanarRing = [];
  for (const point of points) {
    const previous = ring[ring.length - 1];
    if (previous && Math.abs(previous[0] - point[0]) < 1e-9 && Math.abs(previous[1] - point[1]) < 1e-9) continue;
    ring.push(point);
  }
  while (ring.length > 1) {
    const first = ring[0];
    const last = ring[ring.length - 1];
    if (Math.abs(first[0] - last[0]) < 1e-9 && Math.abs(first[1] - last[1]) < 1e-9) ring.pop();
    else break;
  }
  return ring;
}

function prepareRing(points: PlanarPoint[], tolerance: number, role: 'outer' | 'hole'): PlanarRing | null {
  const ring = simplifyRing(cleanRing(points), tolerance);
  if (ring.length < 3 || Math.abs(signedArea(ring)) < 1e-10) return null;
  const wantCounterClockwise = role === 'outer';
  return isCounterClockwiseFromAbove(ring) === wantCounterClockwise ? ring : ring.slice().reverse();
}

function boundsOf(polygons: PlanarPolygon[]): Bounds {
  const bounds = { minX: Infinity, minZ: Infinity, maxX: -Infinity, maxZ: -Infinity };
  for (const polygon of polygons) {
    for (const [x, z] of polygon.outer) {
      bounds.minX = Math.min(bounds.minX, x);
      bounds.maxX = Math.max(bounds.maxX, x);
      bounds.minZ = Math.min(bounds.minZ, z);
      bounds.maxZ = Math.max(bounds.maxZ, z);
    }
  }
  return bounds;
}

/**
 * Projects county boundaries into a centered planar frame. Winding is normalized here, so input
 * rings may follow either the RFC 7946 or the d3 (spherical) convention.
 */
export function buildMapLayout(collection: CountyFeatureCollection, options: LayoutOptions = {}): MapLayout {
  const span = options.span ?? MAP_SPAN;
  const tolerance = options.simplifyTolerance ?? DEFAULT_SIMPLIFY_TOLERANCE;
  const projection = createTexasProjection();
  const projectRaw = (lon: number, lat: number): [number, number] | null => {
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
    const projected = projection([lon, lat]);
    return projected && Number.isFinite(projected[0]) && Number.isFinite(projected[1]) ? projected : null;
  };

  const raw = (collection.features ?? []).map((feature) => ({
    fips: String(feature.properties?.fips ?? ''),
    name: String(feature.properties?.name ?? ''),
    polygons: polygonsOf(feature.geometry).map((rings) =>
      rings.map((ring) => {
        const points: [number, number][] = [];
        for (const position of ring) {
          const projected = projectRaw(position[0], position[1]);
          if (projected) points.push(projected);
        }
        return points;
      }),
    ),
  }));

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const feature of raw) {
    for (const rings of feature.polygons) {
      for (const [x, y] of rings[0] ?? []) {
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
      }
    }
  }
  const extent = Math.max(maxX - minX, maxY - minY);
  if (!Number.isFinite(extent) || extent <= 0) {
    return { counties: [], bounds: { ...EMPTY_BOUNDS }, hull: [], span, vertexCount: 0, project: () => null };
  }

  const scale = span / extent;
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const toPlanar = ([x, y]: [number, number]): PlanarPoint => [(x - cx) * scale, (y - cy) * scale];

  const byFips = new Map<string, PlanarPolygon[]>();
  const names = new Map<string, string>();
  for (const feature of raw) {
    const polygons: PlanarPolygon[] = [];
    for (const [outerRaw, ...holeRaws] of feature.polygons) {
      if (!outerRaw) continue;
      const outer = prepareRing(outerRaw.map(toPlanar), tolerance, 'outer');
      if (!outer) continue;
      const holes: PlanarRing[] = [];
      for (const holeRaw of holeRaws) {
        const hole = prepareRing(holeRaw.map(toPlanar), tolerance, 'hole');
        if (hole) holes.push(hole);
      }
      polygons.push({ outer, holes });
    }
    if (polygons.length === 0) continue;
    // Features sharing a FIPS code (split multipolygons) become one county.
    byFips.set(feature.fips, [...(byFips.get(feature.fips) ?? []), ...polygons]);
    if (!names.has(feature.fips)) names.set(feature.fips, feature.name);
  }

  const counties: PlanarCounty[] = [];
  const hullCandidates: PlanarPoint[] = [];
  let vertexCount = 0;
  for (const [fips, polygons] of byFips) {
    let largest = polygons[0];
    let largestArea = -Infinity;
    let area = 0;
    for (const polygon of polygons) {
      const polygonArea_ = polygonArea(polygon);
      area += polygonArea_;
      if (polygonArea_ > largestArea) {
        largestArea = polygonArea_;
        largest = polygon;
      }
      vertexCount += polygon.outer.length + polygon.holes.reduce((sum, hole) => sum + hole.length, 0);
      hullCandidates.push(...convexHull(polygon.outer));
    }
    counties.push({ fips, name: names.get(fips) ?? fips, polygons, bounds: boundsOf(polygons), area, labelPoint: interiorPoint(largest) });
  }

  const bounds = counties.reduce<Bounds>(
    (acc, county) => ({
      minX: Math.min(acc.minX, county.bounds.minX),
      minZ: Math.min(acc.minZ, county.bounds.minZ),
      maxX: Math.max(acc.maxX, county.bounds.maxX),
      maxZ: Math.max(acc.maxZ, county.bounds.maxZ),
    }),
    { minX: Infinity, minZ: Infinity, maxX: -Infinity, maxZ: -Infinity },
  );

  return {
    counties,
    bounds: counties.length > 0 ? bounds : { ...EMPTY_BOUNDS },
    hull: convexHull(hullCandidates),
    span,
    vertexCount,
    project: (lon, lat) => {
      const projected = projectRaw(lon, lat);
      return projected ? toPlanar(projected) : null;
    },
  };
}

/** SVG path data in planar units (z already points down, matching SVG's y axis). */
export function countyPathData(county: PlanarCounty, digits = 3): string {
  let path = '';
  for (const polygon of county.polygons) {
    for (const ring of [polygon.outer, ...polygon.holes]) {
      ring.forEach(([x, z], index) => {
        path += `${index === 0 ? 'M' : 'L'}${x.toFixed(digits)} ${z.toFixed(digits)}`;
      });
      path += 'Z';
    }
  }
  return path;
}
