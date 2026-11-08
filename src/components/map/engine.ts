import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DirectionalLight,
  Group,
  HemisphereLight,
  LineSegments,
  MathUtils,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  MOUSE,
  PCFSoftShadowMap,
  PerspectiveCamera,
  PlaneGeometry,
  Raycaster,
  Scene,
  ShaderMaterial,
  ShadowMaterial,
  TOUCH,
  Vector2,
  Vector3,
  WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import {
  CAMERA_FOV,
  DEFAULT_TILT,
  MAX_TILT,
  MIN_RETURN_TILT,
  TOP_DOWN_PHI,
  clonePose,
  easeInOutCubic,
  fitPose,
  interpolatePose,
  poseToPosition,
  wrapAngle,
  type Insets,
  type ViewPose,
} from './camera';
import { CITY_LABELS } from './cities';
import { displayHeight, encodeCounty, FLAT_HEIGHT, type CountyEncoding } from './encoding';
import { buildBorderBuffers, buildExtrusion, buildOutlinePositions } from './geometry';
import { findCountyAt, MAP_SPAN, type MapLayout, type PlanarCounty } from './projection';

export type ViewMode = '2d' | '3d';

export interface PointerInfo {
  clientX: number;
  clientY: number;
  pointerType: string;
}

export interface HoverEvent extends PointerInfo {
  fips: string | null;
}

export interface PickEvent extends PointerInfo {
  fips: string;
}

export interface ViewState {
  /** Degrees clockwise from north-up. */
  bearing: number;
  /** Degrees away from a straight-down view. */
  tilt: number;
}

export interface EngineCallbacks {
  onHover(event: HoverEvent): void;
  onPick(event: PickEvent): void;
  /** A drag, pinch or wheel gesture began on the canvas. */
  onGesture(): void;
  onView(view: ViewState): void;
  onContextLost(): void;
  onContextRestored(): void;
}

export interface EngineOptions {
  mode: ViewMode;
  reducedMotion: boolean;
}

interface CountyEntry {
  county: PlanarCounty;
  encoding: CountyEncoding;
  mesh: Mesh;
  top: MeshBasicMaterial;
  wall: MeshLambertMaterial;
  outline: Float32Array | null;
}

interface OverlayLabel {
  element: HTMLElement;
  x: number;
  z: number;
  height: number;
  visible: boolean;
}

interface Tween<T> {
  from: T;
  to: T;
  start: number;
  duration: number;
}

const ACCENT = '#dd885c';
const HOVER_INK = '#173e35';
const DURATION = { mode: 900, reset: 800, step: 380, focus: 850, rise: 1300 } as const;
const MIN_DISTANCE = MAP_SPAN * 0.15;

/** Zeroes OrbitControls' damping momentum so a programmatic move does not drift afterwards. */
function stopMomentum(controls: OrbitControls) {
  const internals = controls as unknown as {
    _sphericalDelta?: { set(radius: number, phi: number, theta: number): unknown };
    _panOffset?: Vector3;
    _scale?: number;
  };
  internals._sphericalDelta?.set(0, 0, 0);
  internals._panOffset?.set(0, 0, 0);
  if (typeof internals._scale === 'number') internals._scale = 1;
}

function createGroundMaterial(): ShaderMaterial {
  return new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: {
      uLineColor: { value: new Color('#b9cbc0') },
      uGlowColor: { value: new Color('#ffffff') },
      uCell: { value: 2 },
      uFadeStart: { value: MAP_SPAN * 0.42 },
      uFadeEnd: { value: MAP_SPAN * 1.4 },
      uGlowRadius: { value: MAP_SPAN * 0.9 },
    },
    vertexShader: /* glsl */ `
      varying vec2 vGround;
      void main() {
        vec4 world = modelMatrix * vec4(position, 1.0);
        vGround = world.xz;
        gl_Position = projectionMatrix * viewMatrix * world;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uLineColor;
      uniform vec3 uGlowColor;
      uniform float uCell;
      uniform float uFadeStart;
      uniform float uFadeEnd;
      uniform float uGlowRadius;
      varying vec2 vGround;
      void main() {
        vec2 coord = vGround / uCell;
        vec2 distanceToLine = abs(fract(coord - 0.5) - 0.5) / fwidth(coord);
        float line = 1.0 - min(min(distanceToLine.x, distanceToLine.y), 1.0);
        float radius = length(vGround);
        float lineAlpha = line * 0.5 * (1.0 - smoothstep(uFadeStart, uFadeEnd, radius));
        float glow = 0.6 * (1.0 - smoothstep(0.0, uGlowRadius, radius));
        float alpha = lineAlpha + glow * (1.0 - lineAlpha);
        if (alpha < 0.002) discard;
        gl_FragColor = vec4(mix(uGlowColor, uLineColor, lineAlpha / alpha), alpha);
        #include <colorspace_fragment>
      }
    `,
  });
}

/** County borders drawn on top of each prism; the extrusion factor is applied on the GPU. */
function createBorderMaterial(): ShaderMaterial {
  return new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: {
      uExtrusion: { value: 1 },
      uMinHeight: { value: FLAT_HEIGHT },
      uColor: { value: new Color('#ffffff') },
      uOpacity: { value: 0.75 },
    },
    vertexShader: /* glsl */ `
      attribute float aHeight;
      uniform float uExtrusion;
      uniform float uMinHeight;
      void main() {
        vec3 p = position;
        p.y = max(uMinHeight, aHeight * uExtrusion);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform float uOpacity;
      void main() {
        gl_FragColor = vec4(uColor, uOpacity);
        #include <colorspace_fragment>
      }
    `,
  });
}

/**
 * Imperative three.js scene for the county map. Owns the renderer, camera, controls, picking and
 * label overlay; the React component drives it through the public methods and receives events
 * through callbacks. The constructor throws when WebGL 2 is unavailable.
 */
export class CountyMapEngine {
  readonly canvas: HTMLCanvasElement;

  private readonly renderer: WebGLRenderer;
  private readonly scene = new Scene();
  private readonly camera = new PerspectiveCamera(CAMERA_FOV, 1, 0.5, 2000);
  private readonly controls: OrbitControls;
  private readonly raycaster = new Raycaster();
  private readonly countyGroup = new Group();
  private readonly sun: DirectionalLight;
  private readonly ground: Mesh<PlaneGeometry, ShaderMaterial>;
  private readonly shadowFloor: Mesh<PlaneGeometry, ShadowMaterial>;
  private readonly borderMaterial = createBorderMaterial();
  private borders: LineSegments<BufferGeometry, ShaderMaterial> | null = null;
  private readonly hoverLine: LineSegments2;
  private readonly selectHalo: LineSegments2;
  private readonly selectLine: LineSegments2;
  private readonly lineMaterials: LineMaterial[];
  private readonly resizeObserver: ResizeObserver;

  private entries = new Map<string, CountyEntry>();
  private pickables: Mesh[] = [];
  private layout: MapLayout | null = null;
  private encodings: Map<string, CountyEncoding> | null = null;
  private fitPoints3D: number[] = [];
  private fitPoints2D: number[] = [];
  private home: Record<ViewMode, ViewPose> | null = null;
  private atHome = true;
  private saved3D = { phi: DEFAULT_TILT, theta: 0 };

  private mode: ViewMode;
  private extrusion: number;
  private reducedMotion: boolean;
  private cameraTween: Tween<ViewPose> | null = null;
  private extrusionTween: Tween<number> | null = null;

  private hoveredFips: string | null = null;
  private selectedFips: string | null = null;
  private labels: OverlayLabel[] = [];
  private selectionLabel: OverlayLabel | null = null;

  private width = 1;
  private height = 1;
  private frame = 0;
  private needsRender = true;
  private hoverDirty = false;
  private gestureActive = false;
  private disposed = false;
  private lastView: ViewState = { bearing: Number.NaN, tilt: Number.NaN };
  private readonly pointer = {
    inside: false,
    clientX: 0,
    clientY: 0,
    type: 'mouse',
    down: null as { id: number; x: number; y: number; button: number } | null,
    dragging: false,
    multi: false,
    active: new Set<number>(),
  };
  private readonly scratch = new Vector3();
  private readonly ndc = new Vector2();

  constructor(
    host: HTMLElement,
    private readonly labelLayer: HTMLElement,
    private readonly callbacks: EngineCallbacks,
    options: EngineOptions,
  ) {
    this.mode = options.mode;
    this.reducedMotion = options.reducedMotion;
    this.extrusion = this.mode === '3d' ? 1 : 0;

    const renderer = new WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
    this.renderer = renderer;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setClearColor(0x000000, 0);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = PCFSoftShadowMap;
    // Shadows only change with the extrusion, not with the camera.
    renderer.shadowMap.autoUpdate = false;
    this.canvas = renderer.domElement;
    this.canvas.className = 'map-canvas';
    this.canvas.setAttribute('aria-hidden', 'true');
    host.appendChild(this.canvas);

    const hemisphere = new HemisphereLight('#ffffff', '#b8c7bd', 2.3);
    this.sun = new DirectionalLight('#fff7ea', 1.7);
    // Classic cartographic illumination from the north-west.
    this.sun.position.set(-0.55, 1, -0.4).normalize().multiplyScalar(MAP_SPAN * 1.6);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.02;
    const shadowCamera = this.sun.shadow.camera;
    const reach = MAP_SPAN * 0.78;
    shadowCamera.left = -reach;
    shadowCamera.right = reach;
    shadowCamera.top = reach;
    shadowCamera.bottom = -reach;
    shadowCamera.near = 1;
    shadowCamera.far = MAP_SPAN * 4;
    shadowCamera.updateProjectionMatrix();

    this.ground = new Mesh(new PlaneGeometry(MAP_SPAN * 6, MAP_SPAN * 6), createGroundMaterial());
    this.ground.rotation.x = -Math.PI / 2;
    this.ground.position.y = -0.01;
    this.ground.renderOrder = -2;
    this.shadowFloor = new Mesh(
      new PlaneGeometry(MAP_SPAN * 4, MAP_SPAN * 4),
      new ShadowMaterial({ color: '#1d3a31', opacity: 0.14, depthWrite: false }),
    );
    this.shadowFloor.rotation.x = -Math.PI / 2;
    this.shadowFloor.position.y = -0.005;
    this.shadowFloor.receiveShadow = true;
    this.shadowFloor.renderOrder = -1;
    this.scene.add(hemisphere, this.sun, this.sun.target, this.ground, this.shadowFloor, this.countyGroup);

    // Transparent so these draw after the (transparent) county borders and are not crossed by them.
    const hoverMaterial = new LineMaterial({ color: HOVER_INK, linewidth: 1.6, transparent: true, opacity: 0.9 });
    const haloMaterial = new LineMaterial({ color: '#ffffff', linewidth: 6.5, transparent: true });
    const selectMaterial = new LineMaterial({ color: ACCENT, linewidth: 3.2, transparent: true });
    this.lineMaterials = [hoverMaterial, haloMaterial, selectMaterial];
    this.hoverLine = new LineSegments2(new LineSegmentsGeometry(), hoverMaterial);
    this.selectHalo = new LineSegments2(new LineSegmentsGeometry(), haloMaterial);
    this.selectLine = new LineSegments2(new LineSegmentsGeometry(), selectMaterial);
    this.hoverLine.renderOrder = 3;
    this.selectHalo.renderOrder = 4;
    this.selectLine.renderOrder = 5;

    this.camera.position.set(0, MAP_SPAN, MAP_SPAN);
    const controls = new OrbitControls(this.camera, this.canvas);
    this.controls = controls;
    controls.enableDamping = !this.reducedMotion;
    controls.dampingFactor = 0.1;
    controls.screenSpacePanning = false;
    controls.zoomToCursor = true;
    controls.rotateSpeed = 0.6;
    controls.minPolarAngle = 0;
    controls.maxPolarAngle = MAX_TILT;
    controls.minDistance = MIN_DISTANCE;
    controls.maxDistance = MAP_SPAN * 6;
    controls.maxTargetRadius = MAP_SPAN * 0.65;
    controls.addEventListener('start', this.onControlsStart);
    controls.addEventListener('change', this.onControlsChange);
    controls.addEventListener('end', this.onControlsEnd);
    this.applyControlScheme();

    this.canvas.addEventListener('pointerdown', this.onPointerDown);
    this.canvas.addEventListener('pointermove', this.onPointerMove);
    this.canvas.addEventListener('pointerup', this.onPointerUp);
    this.canvas.addEventListener('pointercancel', this.onPointerCancel);
    this.canvas.addEventListener('pointerenter', this.onPointerEnter);
    this.canvas.addEventListener('pointerleave', this.onPointerLeave);
    this.canvas.addEventListener('webglcontextlost', this.onContextLost);
    this.canvas.addEventListener('webglcontextrestored', this.onContextRestored);
    this.canvas.style.cursor = 'grab';

    this.resizeObserver = new ResizeObserver((entries) => {
      const rect = entries[entries.length - 1]?.contentRect;
      if (rect) this.resize(rect.width, rect.height);
    });
    this.resizeObserver.observe(host);
    const rect = host.getBoundingClientRect();
    this.resize(rect.width, rect.height);
  }

  // ---------------------------------------------------------------- public API

  setData(layout: MapLayout, encodings: Map<string, CountyEncoding>) {
    if (this.disposed || (layout === this.layout && encodings === this.encodings)) return;
    const firstData = this.entries.size === 0;
    this.clearCounties();
    this.layout = layout;
    this.encodings = encodings;

    for (const county of layout.counties) {
      const encoding = encodings.get(county.fips) ?? encodeCounty(county.fips, county.name, undefined);
      const data = buildExtrusion(county.polygons);
      const geometry = new BufferGeometry();
      geometry.setAttribute('position', new BufferAttribute(data.positions, 3));
      geometry.setAttribute('normal', new BufferAttribute(data.normals, 3));
      geometry.setIndex(new BufferAttribute(data.indices, 1));
      geometry.addGroup(0, data.topIndexCount, 0);
      geometry.addGroup(data.topIndexCount, data.wallIndexCount, 1);
      geometry.computeBoundingBox();
      geometry.computeBoundingSphere();
      // Unlit tops reproduce the legend colors exactly; lit walls carry the depth cue. Polygon
      // offset keeps border lines drawn at the same height from z-fighting with the tops.
      const surface = { polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1, fog: false };
      const top = new MeshBasicMaterial({ color: encoding.color, ...surface });
      const wall = new MeshLambertMaterial({ color: encoding.color, ...surface });
      const mesh = new Mesh(geometry, [top, wall]);
      mesh.castShadow = true;
      mesh.userData.fips = county.fips;
      mesh.scale.y = displayHeight(encoding.height, this.extrusion);
      this.countyGroup.add(mesh);
      this.pickables.push(mesh);
      this.entries.set(county.fips, { county, encoding, mesh, top, wall, outline: null });
    }

    const border = buildBorderBuffers(
      [...this.entries.values()].map((entry) => ({ polygons: entry.county.polygons, height: entry.encoding.height })),
    );
    const borderGeometry = new BufferGeometry();
    borderGeometry.setAttribute('position', new BufferAttribute(border.positions, 3));
    borderGeometry.setAttribute('aHeight', new BufferAttribute(border.heights, 1));
    this.borders = new LineSegments(borderGeometry, this.borderMaterial);
    this.borders.frustumCulled = false;
    this.borders.renderOrder = 1;
    this.scene.add(this.borders);

    this.buildFitPoints();
    this.computeHomes();
    this.buildLabels();

    if (firstData && this.home) {
      this.applyPose(this.home[this.mode]);
      this.atHome = true;
      this.controls.update();
    }
    if (firstData && this.mode === '3d' && !this.reducedMotion) {
      this.applyExtrusion(0);
      this.animateExtrusion(1, DURATION.rise);
    } else {
      this.applyExtrusion(this.mode === '3d' ? 1 : 0);
    }

    this.hoveredFips = null;
    this.hoverLine.removeFromParent();
    const selected = this.selectedFips;
    this.selectedFips = null;
    this.setSelected(selected);
    this.invalidate();
  }

  setSelected(fips: string | null, options: { focus?: boolean } = {}) {
    if (this.disposed) return;
    const previous = this.selectedFips;
    this.selectedFips = fips;
    if (previous && previous !== fips) this.paintWalls(previous);
    if (fips) this.paintWalls(fips);
    this.attachOutline(this.selectHalo, fips);
    this.attachOutline(this.selectLine, fips);
    this.updateSelectionLabel();
    if (options.focus && fips) this.focusCounty(fips);
    this.renderer.shadowMap.needsUpdate = true;
    this.invalidate();
  }

  setMode(mode: ViewMode) {
    if (this.disposed || mode === this.mode) return;
    const from = this.currentPose();
    if (this.mode === '3d') this.saved3D = { phi: Math.max(from.phi, MIN_RETURN_TILT), theta: from.theta };
    this.mode = mode;
    this.applyControlScheme();
    if (this.home) {
      let to: ViewPose;
      if (this.atHome) {
        to = clonePose(this.home[mode]);
      } else {
        // Keep the place and zoom level the reader chose; only the viewing angle changes.
        const scale = this.home[mode].radius / this.home[mode === '2d' ? '3d' : '2d'].radius;
        to = {
          target: from.target.clone(),
          radius: this.clampRadius(from.radius * scale),
          phi: mode === '2d' ? TOP_DOWN_PHI : this.saved3D.phi,
          theta: mode === '2d' ? 0 : this.saved3D.theta,
        };
      }
      this.animateTo(to, DURATION.mode);
    }
    this.animateExtrusion(mode === '3d' ? 1 : 0, DURATION.mode);
  }

  setReducedMotion(reduced: boolean) {
    if (this.disposed) return;
    this.reducedMotion = reduced;
    this.controls.enableDamping = !reduced;
    if (reduced) {
      if (this.cameraTween) this.applyPose(this.cameraTween.to);
      if (this.extrusionTween) this.applyExtrusion(this.extrusionTween.to);
      this.cameraTween = null;
      this.extrusionTween = null;
      this.invalidate();
    }
  }

  zoomBy(factor: number) {
    const base = this.basePose();
    if (!base) return;
    this.atHome = false;
    this.animateTo({ ...base, radius: this.clampRadius(base.radius * factor) }, DURATION.step);
  }

  rotateBy(degrees: number) {
    const base = this.basePose();
    if (!base || this.mode === '2d') return;
    this.atHome = false;
    this.animateTo({ ...base, theta: base.theta + MathUtils.degToRad(degrees) }, DURATION.step);
  }

  tiltBy(degrees: number) {
    const base = this.basePose();
    if (!base || this.mode === '2d') return;
    this.atHome = false;
    const phi = MathUtils.clamp(base.phi + MathUtils.degToRad(degrees), TOP_DOWN_PHI, MAX_TILT);
    this.animateTo({ ...base, phi }, DURATION.step);
  }

  /** Pans by fractions of the visible view; positive y moves the view toward the top of the screen. */
  panBy(xFraction: number, yFraction: number) {
    const base = this.basePose();
    if (!base) return;
    this.atHome = false;
    const halfHeight = base.radius * Math.tan(MathUtils.degToRad(CAMERA_FOV) / 2);
    const right = new Vector3(Math.cos(base.theta), 0, -Math.sin(base.theta));
    const forward = new Vector3(-Math.sin(base.theta), 0, -Math.cos(base.theta));
    const target = base.target
      .clone()
      .addScaledVector(right, xFraction * 2 * halfHeight * this.camera.aspect)
      .addScaledVector(forward, (yFraction * 2 * halfHeight) / Math.max(Math.cos(base.phi), 0.35));
    target.clampLength(0, this.controls.maxTargetRadius);
    this.animateTo({ ...base, target }, DURATION.step);
  }

  resetView() {
    if (!this.home) return;
    this.atHome = true;
    this.animateTo(this.home[this.mode], DURATION.reset);
  }

  resetBearing() {
    const base = this.basePose();
    if (!base) return;
    this.animateTo({ ...base, theta: 0 }, DURATION.step);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.resizeObserver.disconnect();
    this.canvas.removeEventListener('pointerdown', this.onPointerDown);
    this.canvas.removeEventListener('pointermove', this.onPointerMove);
    this.canvas.removeEventListener('pointerup', this.onPointerUp);
    this.canvas.removeEventListener('pointercancel', this.onPointerCancel);
    this.canvas.removeEventListener('pointerenter', this.onPointerEnter);
    this.canvas.removeEventListener('pointerleave', this.onPointerLeave);
    this.canvas.removeEventListener('webglcontextlost', this.onContextLost);
    this.canvas.removeEventListener('webglcontextrestored', this.onContextRestored);
    this.controls.removeEventListener('start', this.onControlsStart);
    this.controls.removeEventListener('change', this.onControlsChange);
    this.controls.removeEventListener('end', this.onControlsEnd);
    this.controls.dispose();
    this.clearCounties();
    this.borderMaterial.dispose();
    this.ground.geometry.dispose();
    this.ground.material.dispose();
    this.shadowFloor.geometry.dispose();
    this.shadowFloor.material.dispose();
    for (const line of [this.hoverLine, this.selectHalo, this.selectLine]) line.geometry.dispose();
    for (const material of this.lineMaterials) material.dispose();
    this.sun.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.canvas.remove();
    this.labelLayer.replaceChildren();
  }

  // ---------------------------------------------------------------- scene building

  private clearCounties() {
    this.hoverLine.removeFromParent();
    this.selectHalo.removeFromParent();
    this.selectLine.removeFromParent();
    for (const entry of this.entries.values()) {
      entry.mesh.removeFromParent();
      entry.mesh.geometry.dispose();
      entry.top.dispose();
      entry.wall.dispose();
    }
    this.entries.clear();
    this.pickables = [];
    if (this.borders) {
      this.borders.removeFromParent();
      this.borders.geometry.dispose();
      this.borders = null;
    }
    for (const label of this.labels) label.element.remove();
    this.labels = [];
    this.selectionLabel = null;
  }

  private buildFitPoints() {
    const layout = this.layout;
    if (!layout) return;
    this.fitPoints2D = [];
    this.fitPoints3D = [];
    for (const [x, z] of layout.hull) {
      this.fitPoints2D.push(x, FLAT_HEIGHT, z);
      this.fitPoints3D.push(x, 0, z);
    }
    // County tops at full height, so tall counties near the edges never leave the frame.
    for (const entry of this.entries.values()) {
      const { minX, maxX, minZ, maxZ } = entry.county.bounds;
      const h = displayHeight(entry.encoding.height, 1);
      this.fitPoints3D.push(minX, h, minZ, maxX, h, minZ, maxX, h, maxZ, minX, h, maxZ);
    }
  }

  private insets(): Insets {
    const compact = this.width < 560;
    const px = compact ? { top: 54, right: 54, bottom: 100, left: 12 } : { top: 22, right: 70, bottom: 40, left: 22 };
    return {
      top: Math.min(0.3, px.top / this.height),
      right: Math.min(0.3, px.right / this.width),
      bottom: Math.min(0.3, px.bottom / this.height),
      left: Math.min(0.3, px.left / this.width),
    };
  }

  private computeHomes() {
    if (!this.layout || this.fitPoints3D.length === 0) return;
    const aspect = this.width / this.height;
    const insets = this.insets();
    this.home = {
      '3d': fitPose(this.fitPoints3D, { phi: DEFAULT_TILT, theta: 0, aspect, insets }),
      '2d': fitPose(this.fitPoints2D, { phi: TOP_DOWN_PHI, theta: 0, aspect, insets }),
    };
    this.controls.maxDistance = Math.max(this.home['3d'].radius, this.home['2d'].radius) * 2.2;
  }

  private buildLabels() {
    const layout = this.layout;
    if (!layout) return;
    for (const city of CITY_LABELS) {
      const point = layout.project(city.lon, city.lat);
      const county = point ? findCountyAt(layout, point) : null;
      if (!point || !county) continue; // never label a point outside the drawn counties
      const element = this.createLabelElement('map-city', city.name);
      element.dataset.side = city.side;
      this.labels.push({ element, x: point[0], z: point[1], height: this.entries.get(county.fips)?.encoding.height ?? 0, visible: false });
    }
    const pin = this.createLabelElement('map-pin', '');
    pin.hidden = true;
    this.selectionLabel = { element: pin, x: 0, z: 0, height: 0, visible: false };
    this.labels.push(this.selectionLabel);
  }

  /** Labels start hidden and appear on the first render that positions them. */
  private createLabelElement(className: string, text: string): HTMLElement {
    const element = document.createElement('div');
    element.className = className;
    element.style.visibility = 'hidden';
    const dot = document.createElement('span');
    dot.className = 'map-label-dot';
    const name = document.createElement('span');
    name.className = 'map-label-text';
    name.textContent = text;
    element.append(dot, name);
    this.labelLayer.appendChild(element);
    return element;
  }

  private updateSelectionLabel() {
    const label = this.selectionLabel;
    if (!label) return;
    const entry = this.selectedFips ? this.entries.get(this.selectedFips) : undefined;
    label.element.hidden = !entry;
    // Hide until the next render has moved the pin to its new county.
    label.visible = false;
    label.element.style.visibility = 'hidden';
    if (!entry) return;
    label.x = entry.county.labelPoint[0];
    label.z = entry.county.labelPoint[1];
    label.height = entry.encoding.height;
    const text = label.element.querySelector('.map-label-text');
    if (text) text.textContent = entry.encoding.displayName;
  }

  private paintWalls(fips: string) {
    const entry = this.entries.get(fips);
    if (!entry) return;
    const selected = fips === this.selectedFips;
    entry.wall.color.set(selected ? ACCENT : entry.encoding.color);
    entry.wall.emissive.set(selected ? ACCENT : '#000000').multiplyScalar(selected ? 0.3 : 0);
  }

  private attachOutline(line: LineSegments2, fips: string | null) {
    line.removeFromParent();
    const entry = fips ? this.entries.get(fips) : undefined;
    if (!entry) return;
    entry.outline ??= buildOutlinePositions(entry.county.polygons, 1);
    line.geometry.dispose();
    line.geometry = new LineSegmentsGeometry().setPositions(entry.outline);
    // As a child of the county mesh the outline follows its extrusion scale automatically.
    entry.mesh.add(line);
  }

  // ---------------------------------------------------------------- camera

  private applyControlScheme() {
    const controls = this.controls;
    if (this.mode === '2d') {
      controls.enableRotate = false;
      controls.mouseButtons = { LEFT: MOUSE.PAN, MIDDLE: MOUSE.DOLLY, RIGHT: MOUSE.PAN };
      controls.touches = { ONE: TOUCH.PAN, TWO: TOUCH.DOLLY_PAN };
    } else {
      controls.enableRotate = true;
      controls.mouseButtons = { LEFT: MOUSE.ROTATE, MIDDLE: MOUSE.DOLLY, RIGHT: MOUSE.PAN };
      controls.touches = { ONE: TOUCH.ROTATE, TWO: TOUCH.DOLLY_PAN };
    }
  }

  private clampRadius(radius: number): number {
    return MathUtils.clamp(radius, this.controls.minDistance, this.controls.maxDistance);
  }

  private currentPose(): ViewPose {
    const offset = this.scratch.copy(this.camera.position).sub(this.controls.target);
    const radius = Math.max(offset.length(), 1e-6);
    return {
      target: this.controls.target.clone(),
      radius,
      phi: Math.acos(MathUtils.clamp(offset.y / radius, -1, 1)),
      theta: Math.atan2(offset.x, offset.z),
    };
  }

  /** Pose that the next step builds on: the running animation's destination, so rapid clicks accumulate. */
  private basePose(): ViewPose | null {
    if (this.disposed || !this.home) return null;
    return clonePose(this.cameraTween ? this.cameraTween.to : this.currentPose());
  }

  private applyPose(pose: ViewPose) {
    this.controls.target.copy(pose.target);
    poseToPosition(pose, this.camera.position);
    this.camera.lookAt(pose.target);
    this.needsRender = true;
  }

  private animateTo(to: ViewPose, duration: number) {
    stopMomentum(this.controls);
    if (this.reducedMotion || duration <= 0) {
      this.cameraTween = null;
      this.applyPose(to);
    } else {
      this.cameraTween = { from: this.currentPose(), to: clonePose(to), start: performance.now(), duration };
    }
    this.invalidate();
  }

  private focusCounty(fips: string) {
    const entry = this.entries.get(fips);
    const base = this.basePose();
    if (!entry || !base || !this.home) return;
    const [x, z] = entry.county.labelPoint;
    this.atHome = false;
    this.animateTo(
      { ...base, target: new Vector3(x, 0, z), radius: Math.min(base.radius, this.home[this.mode].radius * 0.78) },
      DURATION.focus,
    );
  }

  private animateExtrusion(to: number, duration: number) {
    if (this.reducedMotion || duration <= 0) {
      this.extrusionTween = null;
      this.applyExtrusion(to);
    } else {
      this.extrusionTween = { from: this.extrusion, to, start: performance.now(), duration };
    }
    this.invalidate();
  }

  private applyExtrusion(value: number) {
    this.extrusion = value;
    for (const entry of this.entries.values()) entry.mesh.scale.y = displayHeight(entry.encoding.height, value);
    this.borderMaterial.uniforms.uExtrusion.value = value;
    this.renderer.shadowMap.needsUpdate = true;
    this.needsRender = true;
  }

  // ---------------------------------------------------------------- frame loop

  private invalidate() {
    this.needsRender = true;
    this.requestFrame();
  }

  private requestFrame() {
    if (this.frame || this.disposed) return;
    this.frame = requestAnimationFrame(this.tick);
  }

  private tick = (now: number) => {
    this.frame = 0;
    if (this.disposed) return;
    let animating = false;

    if (this.cameraTween) {
      const tween = this.cameraTween;
      const t = MathUtils.clamp((now - tween.start) / tween.duration, 0, 1);
      this.applyPose(t >= 1 ? tween.to : interpolatePose(tween.from, tween.to, easeInOutCubic(t)));
      if (t >= 1) this.cameraTween = null;
      else animating = true;
    }
    if (this.extrusionTween) {
      const tween = this.extrusionTween;
      const t = MathUtils.clamp((now - tween.start) / tween.duration, 0, 1);
      this.applyExtrusion(tween.from + (tween.to - tween.from) * easeInOutCubic(t));
      if (t >= 1) this.extrusionTween = null;
      else animating = true;
    }

    const moved = this.controls.update();
    if (moved) {
      this.needsRender = true;
      animating = true;
    }
    if (this.hoverDirty || (moved && this.pointer.inside && !this.pointer.dragging)) this.updateHover();
    if (this.needsRender) this.render();
    if (animating) this.requestFrame();
  };

  private render() {
    this.needsRender = false;
    const distance = this.camera.position.distanceTo(this.controls.target);
    const near = Math.max(0.05, distance * 0.02);
    const far = distance * 4 + MAP_SPAN * 3;
    if (Math.abs(near - this.camera.near) > near * 0.05 || Math.abs(far - this.camera.far) > far * 0.05) {
      this.camera.near = near;
      this.camera.far = far;
      this.camera.updateProjectionMatrix();
    }
    this.renderer.render(this.scene, this.camera);
    this.updateOverlay();
    this.emitView();
  }

  private updateOverlay() {
    for (const label of this.labels) {
      if (label.element.hidden) continue;
      this.scratch.set(label.x, displayHeight(label.height, this.extrusion) + 0.02, label.z).project(this.camera);
      const visible =
        this.scratch.z > -1 && this.scratch.z < 1 && Math.abs(this.scratch.x) <= 1.02 && Math.abs(this.scratch.y) <= 1.02;
      if (visible !== label.visible) {
        label.visible = visible;
        label.element.style.visibility = visible ? '' : 'hidden';
      }
      if (visible) {
        const x = ((this.scratch.x + 1) / 2) * this.width;
        const y = ((1 - this.scratch.y) / 2) * this.height;
        label.element.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)`;
      }
    }
  }

  private emitView() {
    const view = {
      bearing: MathUtils.radToDeg(wrapAngle(this.controls.getAzimuthalAngle())),
      tilt: MathUtils.radToDeg(this.controls.getPolarAngle()),
    };
    if (Math.abs(view.bearing - this.lastView.bearing) > 0.05 || Math.abs(view.tilt - this.lastView.tilt) > 0.05 || Number.isNaN(this.lastView.bearing)) {
      this.lastView = view;
      this.callbacks.onView(view);
    }
  }

  private resize(width: number, height: number) {
    if (this.disposed || width < 1 || height < 1) return;
    if (width === this.width && height === this.height && this.home) return;
    this.width = width;
    this.height = height;
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    for (const material of this.lineMaterials) material.resolution.set(width, height);
    this.computeHomes();
    if (this.atHome && this.home && !this.cameraTween) {
      this.applyPose(this.home[this.mode]);
      this.controls.update();
    }
    // Resizing clears the canvas, so draw now rather than leaving a blank frame.
    this.render();
  }

  // ---------------------------------------------------------------- picking and pointer input

  private pick(clientX: number, clientY: number): string | null {
    if (this.pickables.length === 0) return null;
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    this.ndc.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this.camera.updateMatrixWorld();
    this.countyGroup.updateMatrixWorld();
    this.raycaster.setFromCamera(this.ndc, this.camera);
    const hit = this.raycaster.intersectObjects(this.pickables, false)[0];
    return hit ? (hit.object.userData.fips as string) : null;
  }

  private updateHover() {
    this.hoverDirty = false;
    const pointer = this.pointer;
    const canHover = pointer.inside && !pointer.dragging && !pointer.multi && pointer.type !== 'touch';
    const fips = canHover ? this.pick(pointer.clientX, pointer.clientY) : null;
    if (fips !== this.hoveredFips) {
      this.hoveredFips = fips;
      this.attachOutline(this.hoverLine, fips);
      this.needsRender = true;
    }
    this.canvas.style.cursor = pointer.dragging ? 'grabbing' : fips ? 'pointer' : 'grab';
    this.callbacks.onHover({ fips, clientX: pointer.clientX, clientY: pointer.clientY, pointerType: pointer.type });
  }

  private setDragging() {
    if (this.pointer.dragging) return;
    this.pointer.dragging = true;
    this.hoverDirty = true;
    this.requestFrame();
  }

  private resetPointerGesture() {
    const wasDragging = this.pointer.dragging;
    this.pointer.down = null;
    this.pointer.dragging = false;
    this.pointer.multi = false;
    if (wasDragging) {
      this.hoverDirty = true;
      this.requestFrame();
    }
  }

  private onPointerDown = (event: PointerEvent) => {
    const pointer = this.pointer;
    pointer.active.add(event.pointerId);
    pointer.clientX = event.clientX;
    pointer.clientY = event.clientY;
    pointer.type = event.pointerType;
    if (pointer.active.size === 1) {
      pointer.down = { id: event.pointerId, x: event.clientX, y: event.clientY, button: event.button };
      pointer.dragging = false;
      pointer.multi = false;
    } else {
      // A second finger turns the gesture into a pinch; it must never select a county.
      pointer.multi = true;
      this.setDragging();
    }
  };

  private onPointerMove = (event: PointerEvent) => {
    const pointer = this.pointer;
    pointer.clientX = event.clientX;
    pointer.clientY = event.clientY;
    pointer.type = event.pointerType;
    const down = pointer.down;
    if (down && !pointer.dragging && event.pointerId === down.id) {
      const threshold = event.pointerType === 'touch' ? 10 : 5;
      if (Math.hypot(event.clientX - down.x, event.clientY - down.y) > threshold) this.setDragging();
    }
    if (!pointer.dragging) {
      this.hoverDirty = true;
      this.requestFrame();
    }
  };

  private onPointerUp = (event: PointerEvent) => {
    const pointer = this.pointer;
    pointer.active.delete(event.pointerId);
    const down = pointer.down;
    if (down && down.id === event.pointerId && !pointer.dragging && !pointer.multi && down.button === 0) {
      const fips = this.pick(event.clientX, event.clientY);
      if (fips) this.callbacks.onPick({ fips, clientX: event.clientX, clientY: event.clientY, pointerType: event.pointerType });
    }
    if (pointer.active.size === 0) this.resetPointerGesture();
  };

  private onPointerCancel = (event: PointerEvent) => {
    this.pointer.active.delete(event.pointerId);
    if (this.pointer.active.size === 0) this.resetPointerGesture();
  };

  private onPointerEnter = (event: PointerEvent) => {
    this.pointer.inside = true;
    this.pointer.type = event.pointerType;
  };

  private onPointerLeave = () => {
    this.pointer.inside = false;
    this.hoverDirty = true;
    this.requestFrame();
  };

  private onControlsStart = () => {
    this.gestureActive = true;
    this.callbacks.onGesture();
  };

  private onControlsChange = () => {
    if (this.gestureActive) {
      // The reader took over: drop any programmatic animation and stop refitting on resize.
      this.atHome = false;
      this.cameraTween = null;
    }
    this.invalidate();
  };

  private onControlsEnd = () => {
    this.gestureActive = false;
  };

  private onContextLost = (event: Event) => {
    event.preventDefault();
    if (this.disposed) return;
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.callbacks.onContextLost();
  };

  private onContextRestored = () => {
    if (this.disposed) return;
    this.renderer.shadowMap.needsUpdate = true;
    this.callbacks.onContextRestored();
    this.invalidate();
  };
}
