import { MathUtils, PerspectiveCamera, Vector3 } from 'three';

/** Orbit pose around a ground target; phi is measured from straight down (0 = top-down view). */
export interface ViewPose {
  target: Vector3;
  radius: number;
  phi: number;
  theta: number;
}

/** Safe-area insets as fractions of the viewport (0–0.5 each). */
export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export const CAMERA_FOV = 30;
/** Near-zero rather than zero so lookAt keeps a stable north-up orientation. */
export const TOP_DOWN_PHI = 1e-4;
export const DEFAULT_TILT = MathUtils.degToRad(36);
export const MAX_TILT = MathUtils.degToRad(62);
export const MIN_RETURN_TILT = MathUtils.degToRad(20);

export function poseToPosition(pose: ViewPose, out = new Vector3()): Vector3 {
  const sinPhi = Math.sin(pose.phi);
  return out.set(
    pose.target.x + pose.radius * sinPhi * Math.sin(pose.theta),
    pose.target.y + pose.radius * Math.cos(pose.phi),
    pose.target.z + pose.radius * sinPhi * Math.cos(pose.theta),
  );
}

export function clonePose(pose: ViewPose): ViewPose {
  return { target: pose.target.clone(), radius: pose.radius, phi: pose.phi, theta: pose.theta };
}

/** Wraps an angle to (-π, π]. */
export function wrapAngle(angle: number): number {
  const wrapped = ((((angle + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) - Math.PI;
  return wrapped === -Math.PI ? Math.PI : wrapped;
}

export function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
}

export function easeOutCubic(t: number): number {
  return 1 - (1 - t) ** 3;
}

/** Interpolates orbit poses; theta follows the shorter way around and radius moves geometrically. */
export function interpolatePose(from: ViewPose, to: ViewPose, t: number): ViewPose {
  const deltaTheta = wrapAngle(to.theta - from.theta);
  return {
    target: from.target.clone().lerp(to.target, t),
    radius: from.radius * (to.radius / from.radius) ** t,
    phi: from.phi + (to.phi - from.phi) * t,
    theta: from.theta + deltaTheta * t,
  };
}

export interface NdcExtent {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

const scratch = new Vector3();
const camera = new PerspectiveCamera(CAMERA_FOV, 1, 0.001, 1e7);

/** Normalized-device extent of points (flat xyz triples) for a pose, or null if any point is behind the camera. */
export function projectExtent(points: ArrayLike<number>, pose: ViewPose, fov: number, aspect: number): NdcExtent | null {
  if (camera.fov !== fov || camera.aspect !== aspect) {
    camera.fov = fov;
    camera.aspect = aspect;
    camera.updateProjectionMatrix();
  }
  poseToPosition(pose, camera.position);
  camera.up.set(0, 1, 0);
  camera.lookAt(pose.target);
  camera.updateMatrixWorld(true);
  const extent = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
  for (let i = 0; i + 2 < points.length; i += 3) {
    scratch.set(points[i], points[i + 1], points[i + 2]).applyMatrix4(camera.matrixWorldInverse);
    if (scratch.z > -1e-6) return null;
    scratch.applyMatrix4(camera.projectionMatrix);
    extent.minX = Math.min(extent.minX, scratch.x);
    extent.maxX = Math.max(extent.maxX, scratch.x);
    extent.minY = Math.min(extent.minY, scratch.y);
    extent.maxY = Math.max(extent.maxY, scratch.y);
  }
  return extent;
}

export function safeArea(insets: Insets): NdcExtent {
  return {
    minX: -1 + 2 * insets.left,
    maxX: 1 - 2 * insets.right,
    minY: -1 + 2 * insets.bottom,
    maxY: 1 - 2 * insets.top,
  };
}

export interface FitOptions {
  phi: number;
  theta: number;
  aspect: number;
  insets: Insets;
  fov?: number;
}

/**
 * Finds the closest orbit pose that keeps every point inside the safe area, then recenters the
 * target on the ground so the projected footprint sits in the middle of that area. Works for any
 * aspect ratio because it measures the actual perspective projection rather than a bounding box.
 */
export function fitPose(points: ArrayLike<number>, options: FitOptions): ViewPose {
  const fov = options.fov ?? CAMERA_FOV;
  const aspect = Math.max(0.05, options.aspect);
  const safe = safeArea(options.insets);
  const safeCenterX = (safe.minX + safe.maxX) / 2;
  const safeCenterY = (safe.minY + safe.maxY) / 2;

  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i + 2 < points.length; i += 3) {
    minX = Math.min(minX, points[i]);
    maxX = Math.max(maxX, points[i]);
    minZ = Math.min(minZ, points[i + 2]);
    maxZ = Math.max(maxZ, points[i + 2]);
  }
  const size = Math.max(maxX - minX, maxZ - minZ, 1e-3);
  const pose: ViewPose = {
    target: new Vector3(Number.isFinite(minX) ? (minX + maxX) / 2 : 0, 0, Number.isFinite(minZ) ? (minZ + maxZ) / 2 : 0),
    radius: size * 2,
    phi: options.phi,
    theta: options.theta,
  };
  if (!Number.isFinite(minX)) return pose;

  const fits = (radius: number) => {
    const extent = projectExtent(points, { ...pose, radius }, fov, aspect);
    return (
      extent !== null &&
      extent.minX >= safe.minX &&
      extent.maxX <= safe.maxX &&
      extent.minY >= safe.minY &&
      extent.maxY <= safe.maxY
    );
  };

  const tanHalf = Math.tan(MathUtils.degToRad(fov) / 2);
  const right = new Vector3(Math.cos(options.theta), 0, -Math.sin(options.theta));
  const forward = new Vector3(-Math.sin(options.theta), 0, -Math.cos(options.theta));

  const fitRadius = () => {
    let high = size * 0.5;
    let guard = 0;
    while (!fits(high) && guard++ < 60) high *= 2;
    let low = high / 2;
    if (fits(low)) low = 0;
    for (let i = 0; i < 40; i++) {
      const mid = (low + high) / 2;
      if (fits(mid)) high = mid;
      else low = mid;
    }
    pose.radius = high;
  };

  for (let round = 0; round < 8; round++) {
    fitRadius();
    const extent = projectExtent(points, pose, fov, aspect);
    if (!extent) break;
    const offsetX = (extent.minX + extent.maxX) / 2 - safeCenterX;
    const offsetY = (extent.minY + extent.maxY) / 2 - safeCenterY;
    if (Math.abs(offsetX) < 5e-4 && Math.abs(offsetY) < 5e-4) break;
    // Shift the ground target so the footprint's screen center moves onto the safe-area center.
    const halfHeight = pose.radius * tanHalf;
    pose.target.addScaledVector(right, offsetX * halfHeight * aspect);
    pose.target.addScaledVector(forward, (offsetY * halfHeight) / Math.max(Math.cos(pose.phi), 0.25));
  }
  fitRadius();
  return pose;
}
