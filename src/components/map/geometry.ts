import { ShapeUtils, Vector2 } from 'three';
import type { PlanarPolygon } from './projection';

/**
 * Unit-height prism data for one county: the top cap sits at y = 1 and walls span y = 0..1, so a
 * mesh's scale.y sets the extruded height. No bottom cap is built because the camera never goes
 * below the ground plane.
 */
export interface ExtrusionData {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint16Array | Uint32Array;
  /** Group 0 covers indices [0, topIndexCount); group 1 (walls) follows. */
  topIndexCount: number;
  wallIndexCount: number;
}

export function buildExtrusion(polygons: PlanarPolygon[]): ExtrusionData {
  let ringVertices = 0;
  for (const polygon of polygons) {
    ringVertices += polygon.outer.length;
    for (const hole of polygon.holes) ringVertices += hole.length;
  }
  const vertexCount = ringVertices * 5;
  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const topIndices: number[] = [];
  const wallIndices: number[] = [];
  let cursor = 0;

  const writeVertex = (x: number, y: number, z: number, nx: number, ny: number, nz: number) => {
    const offset = cursor * 3;
    positions[offset] = x;
    positions[offset + 1] = y;
    positions[offset + 2] = z;
    normals[offset] = nx;
    normals[offset + 1] = ny;
    normals[offset + 2] = nz;
    return cursor++;
  };

  for (const polygon of polygons) {
    const rings = [polygon.outer, ...polygon.holes];
    const base = cursor;
    for (const ring of rings) for (const [x, z] of ring) writeVertex(x, 1, z, 0, 1, 0);

    // Rings are already open (no repeated end point), so triangulateShape's indices map 1:1 onto
    // the vertices written above: outer ring first, then holes in order.
    const faces = ShapeUtils.triangulateShape(
      polygon.outer.map(([x, z]) => new Vector2(x, z)),
      polygon.holes.map((hole) => hole.map(([x, z]) => new Vector2(x, z))),
    );
    for (const [a, b, c] of faces) {
      const pa = positions.subarray((base + a) * 3);
      const pb = positions.subarray((base + b) * 3);
      const pc = positions.subarray((base + c) * 3);
      // y component of (B - A) × (C - A); the cap must face +Y.
      const normalY = (pb[2] - pa[2]) * (pc[0] - pa[0]) - (pb[0] - pa[0]) * (pc[2] - pa[2]);
      if (normalY >= 0) topIndices.push(base + a, base + b, base + c);
      else topIndices.push(base + a, base + c, base + b);
    }

    // Outer rings are CCW from above and holes CW, so the right-hand perpendicular of each edge
    // (-dz, dx) always points away from the solid.
    for (const ring of rings) {
      for (let i = 0; i < ring.length; i++) {
        const [x0, z0] = ring[i];
        const [x1, z1] = ring[(i + 1) % ring.length];
        const dx = x1 - x0;
        const dz = z1 - z0;
        const length = Math.hypot(dx, dz) || 1;
        const nx = -dz / length;
        const nz = dx / length;
        const v0 = writeVertex(x0, 0, z0, nx, 0, nz);
        const v1 = writeVertex(x1, 0, z1, nx, 0, nz);
        const v2 = writeVertex(x1, 1, z1, nx, 0, nz);
        const v3 = writeVertex(x0, 1, z0, nx, 0, nz);
        wallIndices.push(v0, v1, v2, v0, v2, v3);
      }
    }
  }

  const IndexArray = vertexCount > 65535 ? Uint32Array : Uint16Array;
  const indices = new IndexArray(topIndices.length + wallIndices.length);
  indices.set(topIndices, 0);
  indices.set(wallIndices, topIndices.length);
  return { positions, normals, indices, topIndexCount: topIndices.length, wallIndexCount: wallIndices.length };
}

/** Line-segment pairs (x, y, z, x, y, z) tracing every ring edge at height y. */
export function buildOutlinePositions(polygons: PlanarPolygon[], y = 1): Float32Array {
  let edges = 0;
  for (const polygon of polygons) {
    edges += polygon.outer.length;
    for (const hole of polygon.holes) edges += hole.length;
  }
  const positions = new Float32Array(edges * 6);
  let offset = 0;
  for (const polygon of polygons) {
    for (const ring of [polygon.outer, ...polygon.holes]) {
      for (let i = 0; i < ring.length; i++) {
        const [x0, z0] = ring[i];
        const [x1, z1] = ring[(i + 1) % ring.length];
        positions.set([x0, y, z0, x1, y, z1], offset);
        offset += 6;
      }
    }
  }
  return positions;
}

/**
 * Merged county borders for a single draw call. Positions sit at y = 0; each vertex carries its
 * county's full extruded height so a shader can apply the current extrusion factor.
 */
export function buildBorderBuffers(counties: { polygons: PlanarPolygon[]; height: number }[]): {
  positions: Float32Array;
  heights: Float32Array;
} {
  const parts = counties.map((county) => buildOutlinePositions(county.polygons, 0));
  const vertexTotal = parts.reduce((sum, part) => sum + part.length / 3, 0);
  const positions = new Float32Array(vertexTotal * 3);
  const heights = new Float32Array(vertexTotal);
  let vertex = 0;
  parts.forEach((part, index) => {
    positions.set(part, vertex * 3);
    heights.fill(counties[index].height, vertex, vertex + part.length / 3);
    vertex += part.length / 3;
  });
  return { positions, heights };
}
