// 바다 밑의 독도 — 독도 해산의 크기를 보여 주는 3D 장면.
// 시간 t(초)를 주면 그 순간의 한 장면을 그리는 구조라서, 미리보기와 영상 렌더링이 같은 코드를 쓴다.
import * as THREE from 'three';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { VERT, TERRAIN_FRAG, SKIRT_FRAG, ISLET_FRAG, WATER_FRAG, WATERSIDE_FRAG, FXAA_FRAG } from './shaders.js';

const DURATION = 54;
const query = new URLSearchParams(location.search);
const $ = (sel) => document.querySelector(sel);

// ───────────────────────── 작은 도구들 ─────────────────────────
const clamp01 = (x) => Math.min(1, Math.max(0, x));
const smooth = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const lerp = (a, b, t) => a + (b - a) * t;
const fadeIO = (t, a, b, fi = 0.6, fo = 0.5) => smooth(a, a + fi, t) * (1 - smooth(b - fo, b, t));
const num = (v, d = 0) => v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });

/** 넘침 없는 매끈한 보간 (단조 3차 에르미트). */
function pchip(xs, ys) {
  const n = xs.length, h = [], d = [], m = new Array(n);
  for (let i = 0; i < n - 1; i++) { h[i] = xs[i + 1] - xs[i]; d[i] = (ys[i + 1] - ys[i]) / h[i]; }
  m[0] = d[0]; m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) {
    if (d[i - 1] * d[i] <= 0) m[i] = 0;
    else { const w1 = 2 * h[i] + h[i - 1], w2 = h[i] + 2 * h[i - 1]; m[i] = (w1 + w2) / (w1 / d[i - 1] + w2 / d[i]); }
  }
  return (x) => {
    if (x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];
    let i = 0; while (x > xs[i + 1]) i++;
    const t = (x - xs[i]) / h[i], t2 = t * t, t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * h[i] * m[i] + (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * h[i] * m[i + 1];
  };
}

// ───────────────────────── 데이터 ─────────────────────────
const [D, terrBuf, islBuf] = await Promise.all([
  fetch('../data/scene.json').then((r) => r.json()),
  fetch('../data/terrain.bin').then((r) => r.arrayBuffer()),
  fetch('../data/islets.bin').then((r) => r.arrayBuffer()),
]);
const T = D.terrain, I = D.islets, F = D.facts, O = D.outlines;
const terr = new Int16Array(terrBuf);
const isl = new Int16Array(islBuf);
const dxk = T.dx_m / 1000, dyk = T.dy_m / 1000;
const BASE_Y = -2.75;                       // 지형 덩어리 바닥 (km)
const BASE_LEVEL = -F.base_depth_m / 1000;  // 해산 밑면 (km)
const PEAK = F.seodo_peak_m / 1000;
const [BCX, BCY] = F.base_centroid_km;      // 밑면 중심 (동, 북)
const BASE_D = F.base_equiv_diameter_km;

// ───────────────────────── 렌더러 ─────────────────────────
// 색은 화면에 보일 값 그대로 다룬다 (직접 짠 셰이더와 three.js 기본 재질의 색 처리를 맞추기 위해)
THREE.ColorManagement.enabled = false;
const canvas = $('#gl');
// 계단 현상 제거: 기본은 화면 전체에 FXAA 를 한 번 거는 방식. 소프트웨어 렌더러에서 MSAA 보다 2~3배 빠르다.
// ?aa=msaa 로 MSAA, ?aa=0 으로 끌 수 있다.
const AA = query.get('aa') ?? 'fxaa';
const renderer = new THREE.WebGLRenderer({ canvas, antialias: AA === 'msaa', alpha: true, preserveDrawingBuffer: true });
renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
renderer.setPixelRatio(1);
renderer.setClearColor(0x000000, 0);

const post = AA === 'fxaa' ? (() => {
  const target = new THREE.WebGLRenderTarget(4, 4, { minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
  const material = new THREE.ShaderMaterial({
    uniforms: { tDiffuse: { value: target.texture }, uRes: { value: new THREE.Vector2(4, 4) } },
    vertexShader: 'void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: FXAA_FRAG, depthTest: false, depthWrite: false, blending: THREE.NoBlending,
  });
  const quadScene = new THREE.Scene();
  quadScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material));
  return { target, material, quadScene, cam: new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1) };
})() : null;
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(26, 16 / 9, 0.05, 2000);
const world = new THREE.Group();            // y 축 배율 = 수직 과장
scene.add(world);

let VW = 1920, VH = 1080, PORTRAIT = false, U = 10.8;
const lineMaterials = [];
function resize() {
  VW = window.innerWidth; VH = window.innerHeight;
  PORTRAIT = VH > VW;
  U = Math.min(VW, VH) / 100;
  document.documentElement.style.setProperty('--u', `${U}px`);
  document.body.classList.toggle('portrait', PORTRAIT);
  renderer.setSize(VW, VH, false);
  if (post) { post.target.setSize(VW, VH); post.material.uniforms.uRes.value.set(VW, VH); }
  camera.aspect = VW / VH;
  for (const m of lineMaterials) m.resolution.set(VW, VH);
}
resize();                                   // 가로·세로에 따라 배치가 달라지므로 가장 먼저 정한다

// ───────────────────────── 텍스처 ─────────────────────────
const hData = new Float32Array(T.w * T.h);
for (let i = 0; i < hData.length; i++) hData[i] = terr[i] * 0.1;
const hTex = new THREE.DataTexture(hData, T.w, T.h, THREE.RedFormat, THREE.FloatType);
hTex.minFilter = hTex.magFilter = THREE.NearestFilter;
hTex.needsUpdate = true;

const iN = I.w * I.h;
const iData = new Float32Array(iN * 2);
for (let i = 0; i < iN; i++) { iData[i * 2] = isl[i] * 0.1; iData[i * 2 + 1] = isl[iN + i] * 0.1; }
const iTex = new THREE.DataTexture(iData, I.w, I.h, THREE.RGFormat, THREE.FloatType);
iTex.minFilter = iTex.magFilter = THREE.NearestFilter;
iTex.needsUpdate = true;

const SUN = new THREE.Vector3(-0.58, 0.60, 0.55).normalize();
const shared = {
  uH: { value: hTex },
  uOrigin: { value: new THREE.Vector2(T.x0, -T.y1) },
  uCell: { value: new THREE.Vector2(dxk, dyk) },
  uSize: { value: new THREE.Vector2(T.w, T.h) },
  uIH: { value: iTex },
  uIOrigin: { value: new THREE.Vector2(I.x0 + I.res_m / 2000, -I.y1 + I.res_m / 2000) },
  uICell: { value: new THREE.Vector2(I.res_m / 1000, I.res_m / 1000) },
  uISize: { value: new THREE.Vector2(I.w, I.h) },
  uSun: { value: SUN },
  uFogColor: { value: new THREE.Color(0xcfe4f3) },
  uFog: { value: 0 },
  uVE: { value: 1 },
  uTime: { value: 0 },
};
const shader = (frag, extra = {}, opts = {}) => new THREE.ShaderMaterial({
  vertexShader: VERT, fragmentShader: frag, uniforms: { ...shared, ...extra }, ...opts,
});

// ───────────────────────── 지형 ─────────────────────────
const STEP = Number(query.get('step') ?? 3);       // 지형 격자를 몇 칸마다 하나씩 쓸지 (작을수록 정밀)
const nx = Math.floor((T.w - 1) / STEP) + 1, nz = Math.floor((T.h - 1) / STEP) + 1;
const X0 = T.x0, Z0 = -T.y1;
const X1 = X0 + (nx - 1) * STEP * dxk, Z1 = Z0 + (nz - 1) * STEP * dyk;
const hAt = (ix, iz) => hData[iz * STEP * T.w + ix * STEP] / 1000;
{
  const pos = new Float32Array(nx * nz * 3);
  for (let iz = 0, k = 0; iz < nz; iz++) {
    for (let ix = 0; ix < nx; ix++) {
      pos[k++] = X0 + ix * STEP * dxk; pos[k++] = hAt(ix, iz); pos[k++] = Z0 + iz * STEP * dyk;
    }
  }
  const idx = new Uint32Array((nx - 1) * (nz - 1) * 6);
  for (let iz = 0, k = 0; iz < nz - 1; iz++) {
    for (let ix = 0; ix < nx - 1; ix++) {
      const a = iz * nx + ix, b = a + 1, c = a + nx, d = c + 1;
      idx[k++] = a; idx[k++] = c; idx[k++] = b; idx[k++] = b; idx[k++] = c; idx[k++] = d;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3((X0 + X1) / 2, -1, (Z0 + Z1) / 2), 90);
  var terrainMat = shader(TERRAIN_FRAG, { uShadeVE: { value: 3.4 }, uContour: { value: 1 } });
  const mesh = new THREE.Mesh(g, terrainMat);
  mesh.frustumCulled = false;
  world.add(mesh);
}

/** 덩어리 둘레를 따라 위·아래 두 줄의 높이로 벽을 세운다. */
function wallGeometry(topOf, bottomOf) {
  const pos = [], nor = [], idx = [];
  const edge = (count, at, n) => {
    const base = pos.length / 3;
    for (let i = 0; i < count; i++) {
      const [x, z, h] = at(i);
      pos.push(x, topOf(h), z, x, bottomOf(h), z);
      nor.push(...n, ...n);
    }
    for (let i = 0; i < count - 1; i++) {
      const a = base + i * 2;
      idx.push(a, a + 1, a + 2, a + 2, a + 1, a + 3);
    }
  };
  edge(nx, (i) => [X0 + i * STEP * dxk, Z1, hAt(i, nz - 1)], [0, 0, 1]);               // 남
  edge(nx, (i) => [X1 - i * STEP * dxk, Z0, hAt(nx - 1 - i, 0)], [0, 0, -1]);          // 북
  edge(nz, (i) => [X0, Z0 + i * STEP * dyk, hAt(0, i)], [-1, 0, 0]);                   // 서
  edge(nz, (i) => [X1, Z1 - i * STEP * dyk, hAt(nx - 1, nz - 1 - i)], [1, 0, 0]);      // 동
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setIndex(idx);
  return g;
}
const skirt = new THREE.Mesh(wallGeometry((h) => h, () => BASE_Y), shader(SKIRT_FRAG, {}, { side: THREE.DoubleSide }));
skirt.frustumCulled = false;
world.add(skirt);

// ───────────────────────── 독도 섬 ─────────────────────────
{
  const S = 2, w = Math.floor((I.w - 1) / S) + 1, h = Math.floor((I.h - 1) / S) + 1;
  const res = I.res_m / 1000;
  const pos = new Float32Array(w * h * 3);
  for (let r = 0, k = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      pos[k++] = I.x0 + (c * S + 0.5) * res;
      pos[k++] = iData[(r * S * I.w + c * S) * 2] / 1000;
      pos[k++] = -I.y1 + (r * S + 0.5) * res;
    }
  }
  const idx = new Uint32Array((w - 1) * (h - 1) * 6);
  for (let r = 0, k = 0; r < h - 1; r++) {
    for (let c = 0; c < w - 1; c++) {
      const a = r * w + c, b = a + 1, cc = a + w, d = cc + 1;
      idx[k++] = a; idx[k++] = cc; idx[k++] = b; idx[k++] = b; idx[k++] = cc; idx[k++] = d;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  const mesh = new THREE.Mesh(g, shader(ISLET_FRAG));
  mesh.frustumCulled = false;
  world.add(mesh);
}

// ───────────────────────── 바다 ─────────────────────────
const waterUniforms = () => ({
  uAlpha: { value: 0.97 }, uReflect: { value: 1 }, uOpacity: { value: 1 },
  uSkyZ: { value: new THREE.Color(0x2a67ad) }, uSkyH: { value: new THREE.Color(0xcfe4f3) },
  uDeep: { value: new THREE.Color(0x0b3566) }, uShallow: { value: new THREE.Color(0x2fa7a0) },
});
const waterMat = shader(WATER_FRAG, waterUniforms(), { transparent: true, depthWrite: false });
const oceanMat = shader(WATER_FRAG, waterUniforms(), { transparent: true, depthWrite: false });
{
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([X0, 0, Z0, X0, 0, Z1, X1, 0, Z0, X1, 0, Z1], 3));
  g.setIndex([0, 1, 2, 2, 1, 3]);
  const top = new THREE.Mesh(g, waterMat);
  top.renderOrder = 3; top.frustumCulled = false;
  world.add(top);
  // 첫 장면에서 수평선까지 이어지는 먼 바다 (덩어리 바깥)
  const far = new THREE.Mesh(new THREE.RingGeometry(0.0, 900, 96, 1).rotateX(-Math.PI / 2), oceanMat);
  far.position.y = -0.002; far.renderOrder = 1; far.frustumCulled = false;
  world.add(far);
  var oceanFar = far;
}
const waterSideMat = shader(WATERSIDE_FRAG, { uAlpha: { value: 0.95 } }, { transparent: true, depthWrite: false });
const waterSides = new THREE.Mesh(wallGeometry(() => 0, (h) => Math.min(h, 0)), waterSideMat);
waterSides.renderOrder = 2; waterSides.frustumCulled = false;
world.add(waterSides);

// ───────────────────────── 비교용 도형 ─────────────────────────
const anno = new THREE.Group();
world.add(anno);
const BASE_LIFT = 0.05;                     // 테두리 선이 바닥에 묻히지 않게 살짝 띄운다
const faders = [];      // { set(opacity) }

function line(points, color, width, { dashed = false, depthTest = true, order = 6 } = {}) {
  const g = new LineGeometry();
  g.setPositions(points.flat());
  const m = new LineMaterial({ color, linewidth: width, transparent: true, opacity: 1, depthTest, depthWrite: false, dashed, dashSize: 0.9, gapSize: 0.6 });
  m.userData.w = width;
  lineMaterials.push(m);
  const l = new Line2(g, m);
  l.computeLineDistances();
  l.renderOrder = order; l.frustumCulled = false;
  return l;
}
function fillShape(xy, color, opacity) {
  const shape = new THREE.Shape(xy.map(([x, y]) => new THREE.Vector2(x, y)));
  const g = new THREE.ShapeGeometry(shape).rotateX(-Math.PI / 2);     // (x, 북) → (x, 0, -북)
  const m = new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false, side: THREE.DoubleSide });
  m.userData.o = opacity;
  const mesh = new THREE.Mesh(g, m);
  mesh.renderOrder = 5; mesh.frustumCulled = false;
  return mesh;
}
/** 여러 물체를 한꺼번에 나타내고 숨기는 묶음. */
function bundle(...objs) {
  const grp = new THREE.Group();
  objs.forEach((o) => grp.add(o));
  anno.add(grp);
  const mats = [];
  grp.traverse((o) => { if (o.material) mats.push(o.material); });
  grp.userData.set = (v) => {
    grp.visible = v > 0.002;
    for (const m of mats) m.opacity = v * (m.userData.o ?? 1);
  };
  grp.userData.set(0);
  return grp;
}
const ring = (xy, y) => [...xy, xy[0]].map(([x, n]) => [x, y, -n]);
const AMBER = 0xffc94d, PINK = 0xff8fa3, WHITE = 0xf4f8ff, CYAN = 0x7fe7ff;

// 물을 걷어 낸 뒤에도 해수면 높이를 알 수 있게 덩어리 윗변에 두르는 선
const seaFrame = bundle(line([[X0, 0, Z0], [X1, 0, Z0], [X1, 0, Z1], [X0, 0, Z1], [X0, 0, Z0]], 0x9fdcff, 2.2));
// 옆에서 보는 장면에서는 독도를 지나는 단면 위에 해수면 선을 긋는다
const seaLine = bundle(line([[X0, 0, 0], [X1, 0, 0]], 0x9fdcff, 2.2));

/** 지형 격자에서 (동, 북) 지점의 높이(km)를 읽는다. */
function terrainKm(x, north) {
  const fx = (x - T.x0) / dxk, fz = (T.y1 - north) / dyk;
  const ix = Math.max(0, Math.min(T.w - 2, Math.floor(fx))), iz = Math.max(0, Math.min(T.h - 2, Math.floor(fz)));
  const ax = fx - ix, az = fz - iz, k = iz * T.w + ix;
  return ((hData[k] * (1 - ax) + hData[k + 1] * ax) * (1 - az) + (hData[k + T.w] * (1 - ax) + hData[k + T.w + 1] * ax) * az) / 1000;
}
// 해산 밑면 테두리 (수심 2,000 m 등심선): 바닥을 따라 두른 선과, 수면으로 들어 올려 넓이를 견줄 평평한 판
// (이웃 해산과 맞닿아 등심선이 끊기는 동쪽 안부 구간은 긋지 않는다)
const drapedRuns = [[]];
for (const [x, n] of [...O.base, O.base[0]]) {
  const y = terrainKm(x, n);
  if (Math.abs(y - BASE_LEVEL) < 0.15) drapedRuns.at(-1).push([x, y + BASE_LIFT, -n]);
  else if (drapedRuns.at(-1).length) drapedRuns.push([]);
}
const baseDraped = bundle(...drapedRuns.filter((r) => r.length > 3).map((r) => line(r, AMBER, 4.5)));
const baseLoop = bundle(line(ring(O.base, 0), AMBER, 4.5), fillShape(O.base, AMBER, 0.13));
// 서울특별시 경계: 밑면 중심에 겹쳐 놓는다
const seoulXY = O.seoul.map(([x, y]) => [x + BCX, y + BCY]);
const seoulLoop = bundle(line(ring(seoulXY, 0), PINK, 4.5), fillShape(seoulXY, PINK, 0.17));
seoulLoop.position.y = 0.05;

// 높이 비교 막대 (밑면 높이에서 위로)
function bar(x, z, heightKm, color) {
  const w = 1.0;
  const box = new THREE.Mesh(
    new THREE.BoxGeometry(w, heightKm, w).translate(x, BASE_LEVEL + heightKm / 2, z),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.34, depthWrite: false }),
  );
  box.material.userData.o = 0.34;
  box.renderOrder = 5;
  const y0 = BASE_LEVEL, y1 = BASE_LEVEL + heightKm, a = w / 2;
  const c = [[x - a, z - a], [x + a, z - a], [x + a, z + a], [x - a, z + a]];
  const edges = [];
  edges.push(line([...c, c[0]].map(([px, pz]) => [px, y1, pz]), color, 3));
  edges.push(line([...c, c[0]].map(([px, pz]) => [px, y0, pz]), color, 2));
  for (const [px, pz] of c) edges.push(line([[px, y0, pz], [px, y1, pz]], color, 2));
  return [box, ...edges];
}
const BAR_Z = 0.0;                           // 꼭대기와 같은 거리에 세워야 원근 때문에 키가 달라 보이지 않는다
const BAR_GAP = PORTRAIT ? 3.5 : 4.0;         // 세로 화면은 폭이 좁아 조금 더 붙여 세운다
const X_BRACKET = BCX - 15.5, X_HALLA = X_BRACKET - BAR_GAP, X_LOTTE = X_HALLA - BAR_GAP;
const lotteBar = bundle(...bar(X_LOTTE, BAR_Z, F.lotte_tower_m / 1000, CYAN));
const hallaBar = bundle(...bar(X_HALLA, BAR_Z, F.hallasan_m / 1000, 0x9be28f));
// 독도 해산의 높이를 재는 치수선
const bracket = bundle(
  line([[X_BRACKET, BASE_LEVEL, BAR_Z], [X_BRACKET, PEAK, BAR_Z]], AMBER, 4.5),
  line([[X_BRACKET - 0.8, PEAK, BAR_Z], [X_BRACKET + 0.8, PEAK, BAR_Z]], AMBER, 4.5),
  line([[X_BRACKET - 0.8, BASE_LEVEL, BAR_Z], [X_BRACKET + 0.8, BASE_LEVEL, BAR_Z]], AMBER, 4.5),
  line([[X_BRACKET + 0.8, PEAK, BAR_Z], [0, PEAK, 0]], AMBER, 2, { dashed: true, depthTest: false }),
  // 높이를 재는 기준선(수심 2,000 m)과 해수면 눈금
  line([[X_LOTTE - 2.2, BASE_LEVEL, BAR_Z], [X_BRACKET + 0.8, BASE_LEVEL, BAR_Z]], WHITE, 2),
  line([[X_LOTTE - 2.2, 0, BAR_Z], [X_LOTTE - 1.0, 0, BAR_Z]], WHITE, 2, { depthTest: false }),
);
// 실제 비율 장면의 치수선
const trueDims = bundle(
  line([[BCX - BASE_D / 2, BASE_LEVEL, 17], [BCX + BASE_D / 2, BASE_LEVEL, 17]], AMBER, 4.5, { depthTest: false }),
  line([[BCX - BASE_D / 2, BASE_LEVEL - 0.35, 17], [BCX - BASE_D / 2, BASE_LEVEL + 0.35, 17]], AMBER, 4.5, { depthTest: false }),
  line([[BCX + BASE_D / 2, BASE_LEVEL - 0.35, 17], [BCX + BASE_D / 2, BASE_LEVEL + 0.35, 17]], AMBER, 4.5, { depthTest: false }),
  line([[BCX - 16.5, BASE_LEVEL, 0], [BCX - 16.5, PEAK, 0]], WHITE, 3.5, { depthTest: false }),
  line([[BCX - 17.2, PEAK, 0], [BCX - 15.8, PEAK, 0]], WHITE, 3.5, { depthTest: false }),
  line([[BCX - 17.2, BASE_LEVEL, 0], [BCX - 15.8, BASE_LEVEL, 0]], WHITE, 3.5, { depthTest: false }),
);
// 위에서 본 장면의 10 km 축척 막대
const SB = PORTRAIT ? { x: BCX - 20.5, z: -BCY - 23 } : { x: BCX - 5, z: 24.5 };
const scaleBar = bundle(
  line([[SB.x, 0.06, SB.z], [SB.x + 10, 0.06, SB.z]], WHITE, 4, { depthTest: false }),
  line([[SB.x, 0.06, SB.z - 0.7], [SB.x, 0.06, SB.z + 0.7]], WHITE, 4, { depthTest: false }),
  line([[SB.x + 10, 0.06, SB.z - 0.7], [SB.x + 10, 0.06, SB.z + 0.7]], WHITE, 4, { depthTest: false }),
);

// ───────────────────────── 화면 글자 ─────────────────────────
const capRoot = $('#captions'), tagRoot = $('#labels'), svg = $('#lines');
const baseArea = Math.round(F.base_area_km2 / 10) * 10;
const totalH = Math.round(F.total_height_m / 10) * 10;
const ratio = Math.round(F.area_ratio / 100) * 100;
const pitches = Math.round(F.dokdo_area_km2 * 1e6 / 7140);
const underPct = Math.floor((1 - F.above_water_volume_fraction_max) * 1e4) / 100;

const caps = [];
function cap(cls, a, b, html, opt = {}) {
  const el = document.createElement('div');
  el.className = `cap ${cls}`;
  el.innerHTML = html;
  capRoot.appendChild(el);
  caps.push({ el, a, b, ...opt });
  return el;
}
cap('pos-tl shadow-day', 0.5, 5.6, `
  <div class="kicker">동해 · 북위 37°14′ 동경 131°52′</div>
  <h1>독도</h1>
  <div class="stats">
    <div class="stat"><div class="v">${num(F.dokdo_area_km2 * 1e6)}<small>m²</small></div><div class="k">물 위로 드러난 넓이</div></div>
    <div class="stat"><div class="v">${F.seodo_peak_m}<small>m</small></div><div class="k">가장 높은 곳 (서도)</div></div>
  </div>`);
cap('pos-bc shadow', 6.6, 11.2, `<h2>넓은 동해 위,<br>눈에 보이는 독도는${PORTRAIT ? '<br>' : ' '}<b>작은 점</b> 하나.</h2><p>축구장 약 ${pitches}개 넓이</p>`);
cap('pos-bl shadow', 11.9, 15.0, `<h2>하지만 바닷물을<br>걷어 내면 —</h2>`);
cap('pos-bl shadow', 15.3, 19.2, `<div class="kicker">바다 밑의 독도</div><h2><b>독도 해산</b></h2><p>수심 약 ${num(F.base_depth_m)} m 해저에서 솟아오른 화산체</p>`);
cap('pos-bl shadow', 20.0, 28.2, `<div class="kicker">높이</div><h2>해저에서 꼭대기까지<br><b>약 ${num(totalH)} m</b></h2><p>한라산(${num(F.hallasan_m)} m)보다 높고,<br>롯데월드타워(${F.lotte_tower_m} m)의 약 ${Math.round(F.total_height_m / F.lotte_tower_m)}배</p>`);
cap('pos-bl shadow', 30.2, 35.6, `<div class="kicker">넓이</div><h2>밑지름 약 ${Math.round(BASE_D)} km,<br>밑면 <b>약 ${baseArea} km²</b></h2><p><span class="seoul">서울특별시</span>(${Math.round(F.seoul_area_km2)} km²)와 맞먹는 넓이</p>`);
cap('pos-bl shadow', 35.9, 40.0, `<h2>물 위의 독도는<br>그 <b>${num(ratio)}분의 1</b></h2><p>약 ${F.dokdo_area_km2.toFixed(2)} km² 대 약 ${baseArea} km²</p>`);
cap('pos-tc shadow', 42.0, 48.2, `<div class="kicker">과장 없는 실제 비율</div><h2>폭 약 ${Math.round(BASE_D)} km${PORTRAIT ? '<br>' : ' · '}높이 약 ${(F.total_height_m / 1000).toFixed(1)} km</h2><p>전체 부피의 <b>${underPct}% 이상</b>이${PORTRAIT ? '<br>' : ' '}바다 아래에 있습니다</p>`);
cap('pos-tc shadow', 48.9, DURATION + 1, `<h2>우리가 보는 독도는<br><b>거대한 해산의 꼭대기</b>입니다.</h2>`);
const badge = cap('', 0, 0, '', { manual: true });
badge.id = 'badge';
const credit = cap('', 49.6, DURATION + 1, `수심 자료 GMRT Synthesis (Ryan et al., 2009) · 해안선·행정 경계 © OpenStreetMap contributors<br>해산 제원은 수심 격자에서 직접 잰 근삿값 (밑면 = 수심 ${num(F.base_depth_m)} m 등심선 안쪽) · 섬의 높낮이는 최고점에 맞춘 근사 모형`);
credit.id = 'credit';

// 3D 위치에 붙는 꼬리표: pos = [동, 높이(km, 과장 전), 남] / off = 화면에서 밀어 낼 거리(u)
const tags = [];
function tag(html, pos, opt = {}) {
  if (PORTRAIT && opt.p) opt = { ...opt, ...opt.p };            // p: 세로 화면에서만 바꿀 값
  const { off = [0, 0], align = 'center', a = 0, b = 0, leader = false, cls = '', fn = null } = opt;
  if (opt.pos) pos = opt.pos;
  const el = document.createElement('div');
  el.className = `tag shadow ${cls}`;
  el.innerHTML = html;
  tagRoot.appendChild(el);
  let ln = null;
  if (leader) {
    ln = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    ln.setAttribute('stroke', 'rgba(244,248,255,0.85)');
    svg.appendChild(ln);
  }
  const o = { el, pos, off, align, a, b, ln, fn };
  tags.push(o);
  return o;
}
const S_ = D.summits;
tag('<div class="t accent">독도</div>', [0, 0.03, 0], { off: [0, -8.5], a: 7.4, b: 14.8, cls: 'big' });
tag('<div class="t accent">독도 해산</div>', [0, 0.0, 0], { off: [0, -7.5], a: 15.6, b: 19.4, leader: true, cls: 'big' });
tag('<div class="t">심흥택 해산</div>', [S_.simheungtaek[0], 0, -S_.simheungtaek[1]], { off: [2, -6], a: 16.2, b: 19.4, leader: true });
tag('<div class="t">이사부 해산</div>', [S_.isabu[0], 0, -S_.isabu[1]], { off: [2, -6], a: 16.6, b: 19.4, leader: true });
// 높이 비교
tag(`<div class="t cyan">롯데월드타워</div><div class="s">${F.lotte_tower_m} m</div>`, [X_LOTTE, BASE_LEVEL + F.lotte_tower_m / 1000, BAR_Z], { off: [0, -5.2], a: 21.4, b: 28.4, p: { off: [0, -6.2], cls: 'tight' } });
tag(`<div class="t" style="color:#9be28f">한라산</div><div class="s">${num(F.hallasan_m)} m</div>`, [X_HALLA, BASE_LEVEL + F.hallasan_m / 1000, BAR_Z], { off: [0, -5.2], a: 22.4, b: 28.4, p: { off: [-2.5, -6.2], cls: 'tight' } });
tag(`<div class="t accent">독도 해산</div><div class="s">약 ${num(totalH)} m</div>`, [X_BRACKET, PEAK, BAR_Z], { off: [0, -5.2], a: 23.4, b: 28.4, p: { off: [3.5, -6.2], align: 'left', cls: 'tight' } });
tag('<div class="s">해수면</div>', [X_LOTTE - 2.2, 0, BAR_Z], { off: [-1.0, -1.7], align: 'right', a: 23.0, b: 28.4, p: { off: [0, -2.2], align: 'left' } });
tag(`<div class="s">수심 ${num(F.base_depth_m)} m</div>`, [X_LOTTE - 2.2, BASE_LEVEL, BAR_Z], { off: [-1.0, 0], align: 'right', a: 23.0, b: 28.4, p: { off: [0, 2.2], align: 'left' } });
// 넓이 비교: 꼬리표는 각 테두리 위의 한 점에서 뻗어 나온다
const pick = (pts, score) => pts.reduce((best, q) => (score(q) > score(best) ? q : best));
const baseNE = pick(O.base, ([x, y]) => 0.55 * x + y);
const seoulE = pick(seoulXY, ([x, y]) => x - 0.9 * Math.abs(y - BCY + 6));
const seoulW = pick(seoulXY, ([x]) => -x);
tag(`<div class="t accent">독도 해산 밑면</div><div class="s">약 ${baseArea} km²</div>`, [baseNE[0], 0.05, -baseNE[1]], { off: [7, -7], align: 'left', a: 31.2, b: 40.2, leader: true, cls: 'pill', p: { off: [1, -9], align: 'center' } });
tag(`<div class="t seoul">서울특별시</div><div class="s">${Math.round(F.seoul_area_km2)} km²</div>`, [seoulE[0], 0.05, -seoulE[1]], { off: [7, 5], align: 'left', a: 33.4, b: 40.2, leader: true, cls: 'pill', p: { pos: [seoulW[0], 0.05, -seoulW[1]], off: [-3, -11], align: 'left' } });
tag('<div class="s">10 km</div>', [SB.x + 5, 0.06, SB.z], { off: [0, 2.6], a: 31.6, b: 40.2 });
tag(`<div class="t accent">물 위의 독도</div><div class="s">약 ${F.dokdo_area_km2.toFixed(2)} km²</div>`, [0, 0.05, 0], { off: [-5.5, -6.5], align: 'right', a: 36.2, b: 40.2, cls: 'pill', p: { off: [5.5, 7.5], align: 'left' } });
// 실제 비율
tag(`<div class="t accent">약 ${Math.round(BASE_D)} km</div>`, [BCX, BASE_LEVEL, 17], { off: [0, -2.6], a: 43.0, b: 48.4 });
tag(`<div class="t">약 ${(F.total_height_m / 1000).toFixed(1)} km</div>`, [BCX - 16.5, (BASE_LEVEL + PEAK) / 2, 0], { off: [-1.6, 0], align: 'right', a: 43.6, b: 48.4, p: { pos: [BCX - 16.5, PEAK, 0], off: [0, -3.4], align: 'center' } });
tag('<div class="t accent">독도</div>', [0, PEAK, 0], { off: [0, -6], a: 43.0, b: DURATION + 1, leader: true });

// 독도를 가리키는 고리
const ringEl = document.createElement('div');
ringEl.className = 'ring';
tagRoot.appendChild(ringEl);

// ───────────────────────── 시간표 ─────────────────────────
// 카메라: 목표점(tx, ty, tz) 주위를 방위(az)·고도(el)·거리(dist)로 돈다. ty 는 과장 전 높이(km).
// az 0° = 남쪽에서 북쪽을 봄, +면 동쪽으로 돌아감.
const KEYS_L = [
  // t,    tx,    ty,    tz,   az,   el,   dist,  fov
  [0.0, 0.02, 0.050, 0.00, 30, 4.0, 2.30, 30],
  [5.4, 0.02, 0.050, 0.00, 15, 5.5, 2.00, 30],
  [8.4, 1.5, 0.0, 0.6, 5, 40, 44, 27],
  [11.4, 9.5, 0.0, 1.0, -8, 57, 190, 24],
  [14.2, 9.5, -0.3, 1.0, -14, 42, 186, 24],
  [18.6, 6.0, -1.0, 2.0, -23, 17, 152, 24],
  [20.6, BCX - 5.5, -0.95, 0.0, -4, 4.0, 75, 24],
  [28.0, BCX - 5.5, -0.95, 0.0, 4, 4.0, 73, 24],
  [31.0, BCX + 1.5, 0.0, -BCY + 1, 0, 84, 132, 24],
  [39.6, BCX + 1.5, 0.0, -BCY + 1, 0, 84, 124, 24],
  [42.4, BCX, -0.2, 0.0, 0, 3.6, 76, 24],
  [48.4, BCX, -0.2, 0.0, -7, 4.6, 74, 24],
  [DURATION, BCX + 2, -0.4, 0.0, -14, 13.0, 100, 24],
];
const KEYS_P = [
  [0.0, 0.02, 0.060, 0.00, 30, 4.0, 2.10, 44],
  [5.4, 0.02, 0.060, 0.00, 15, 5.5, 1.85, 44],
  [8.4, 0.5, 0.0, 0.6, 5, 40, 40, 40],
  [11.4, 3.0, 0.0, 1.0, -8, 60, 150, 40],
  [14.2, 3.0, -0.3, 1.0, -14, 44, 140, 40],
  [18.6, 5.0, -0.2, 2.0, -23, 20, 122, 38],
  [20.6, BCX - 8.3, -2.4, 0.0, -4, 4.0, 94, 38],
  [28.0, BCX - 8.3, -2.4, 0.0, 4, 4.0, 92, 38],
  [31.0, BCX, 0.0, -BCY + 9, 0, 84, 118, 40],
  [39.6, BCX, 0.0, -BCY + 9, 0, 84, 112, 40],
  [42.4, BCX - 1, -3.0, 0.0, 0, 7.0, 104, 38],
  [48.4, BCX - 1, -3.0, 0.0, -7, 8.0, 100, 38],
  [DURATION, BCX + 1, -3.0, 0.0, -14, 17.0, 112, 38],
];
let camTrack = null;
function buildCamera() {
  const K = PORTRAIT ? KEYS_P : KEYS_L;
  const ts = K.map((k) => k[0]);
  const f = [1, 2, 3, 4, 5, 6, 7].map((c) => pchip(ts, K.map((k) => (c === 6 ? Math.log(k[c]) : k[c]))));
  camTrack = (t) => { const v = f.map((g) => g(t)); v[5] = Math.exp(v[5]); return v; };
}

const state = { ve: 1 };
const v3 = new THREE.Vector3();
function project(x, yReal, z) {
  v3.set(x, yReal * state.ve, z).project(camera);
  return [(v3.x * 0.5 + 0.5) * VW, (-v3.y * 0.5 + 0.5) * VH, v3.z < 1];
}

function renderAt(t) {
  t = Math.min(Math.max(t, 0), DURATION);
  // 수직 과장: 처음엔 실제 비율, 물이 불투명한 동안 3배로, 위에서 내려다보는 동안 다시 실제 비율로
  const ve = 1 + 2 * smooth(9.4, 11.4, t) - 2 * smooth(36.2, 39.4, t);
  state.ve = ve;
  world.scale.y = ve;
  shared.uVE.value = ve;
  shared.uTime.value = t;

  // 하늘과 안개: 첫 장면의 낮 풍경 → 어두운 배경의 모형
  const day = 1 - smooth(6.4, 9.6, t);
  $('#bg-sky').style.opacity = day.toFixed(4);
  shared.uFog.value = 0.034 * (1 - smooth(5.6, 10.2, t));
  oceanMat.uniforms.uOpacity.value = day;
  oceanFar.visible = day > 0.002;

  // 바닷물 걷어 내기
  const clear = smooth(12.2, 15.8, t);
  const wAlpha = lerp(1.0, 0.13, clear) - 0.07 * fadeIO(t, 29.5, 41.0, 2.0, 1.5);
  for (const m of [waterMat, oceanMat]) {
    m.uniforms.uAlpha.value = m === oceanMat ? 1.0 : wAlpha;
    m.uniforms.uReflect.value = lerp(lerp(0.35, 1.0, day), 0.16, clear);
    m.uniforms.uSkyZ.value.setRGB(lerp(0.05, 0.165, day), lerp(0.14, 0.404, day), lerp(0.30, 0.678, day));
    m.uniforms.uSkyH.value.setRGB(lerp(0.20, 0.81, day), lerp(0.38, 0.894, day), lerp(0.62, 0.953, day));
    m.uniforms.uDeep.value.setRGB(lerp(0.035, 0.043, day) + 0.10 * clear, lerp(0.19, 0.208, day) + 0.32 * clear, lerp(0.42, 0.40, day) + 0.40 * clear);
  }
  waterSideMat.uniforms.uAlpha.value = lerp(1.0, 0.15, clear);
  terrainMat.uniforms.uContour.value = 1;

  // 카메라
  const [tx, ty, tz, az, el, dist, fov] = camTrack(t);
  const a = THREE.MathUtils.degToRad(az), e = THREE.MathUtils.degToRad(el);
  const target = new THREE.Vector3(tx, ty * ve, tz);
  camera.position.set(tx + dist * Math.sin(a) * Math.cos(e), ty * ve + dist * Math.sin(e), tz + dist * Math.cos(a) * Math.cos(e));
  camera.up.set(0, 1, 0);
  camera.lookAt(target);
  camera.fov = fov;
  camera.near = Math.max(0.02, dist * 0.02);
  camera.far = dist * 6 + 1200;
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);

  // 비교용 도형
  const sLine = Math.min(VW, VH) / 1080;
  for (const m of lineMaterials) m.linewidth = m.userData.w * sLine;
  const lift = smooth(29.4, 31.4, t);                                  // 밑면 테두리를 수면으로 들어 올린다
  baseLoop.position.y = lerp(BASE_LEVEL + BASE_LIFT, 0.04, lift);
  const side = Math.max(fadeIO(t, 19.8, 29.0, 1.0, 1.0), fadeIO(t, 41.6, 49.4, 0.9, 1.2));       // 옆에서 보는 장면
  seaFrame.userData.set(0.75 * smooth(12.6, 15.8, t) * (1 - 0.8 * side));
  seaLine.userData.set(0.85 * side);
  baseLoop.userData.set(fadeIO(t, 29.2, 40.6, 0.5, 0.6));
  baseDraped.userData.set(Math.max(fadeIO(t, 19.6, 29.9, 0.8, 0.5), fadeIO(t, 42.6, DURATION + 1, 0.8, 0.5)));
  seoulLoop.userData.set(fadeIO(t, 32.6, 40.4, 0.9, 0.6));
  lotteBar.userData.set(fadeIO(t, 21.0, 28.6, 0.7, 0.5));
  hallaBar.userData.set(fadeIO(t, 22.0, 28.6, 0.7, 0.5));
  bracket.userData.set(fadeIO(t, 23.0, 28.6, 0.7, 0.5));
  scaleBar.userData.set(fadeIO(t, 31.4, 40.4, 0.6, 0.6));
  trueDims.userData.set(fadeIO(t, 42.8, 48.6, 0.7, 0.6));

  if (post) {
    renderer.setRenderTarget(post.target);
    renderer.render(scene, camera);
    renderer.setRenderTarget(null);
    renderer.render(post.quadScene, post.cam);
  } else {
    renderer.render(scene, camera);
  }

  // 처음과 끝은 어둠에서 열리고 닫힌다
  $('#fade').style.opacity = Math.max(1 - smooth(0, 0.6, t), smooth(DURATION - 0.8, DURATION - 0.05, t)).toFixed(4);

  // 화면 고정 자막
  for (const c of caps) {
    if (c.manual) continue;
    const o = fadeIO(t, c.a, c.b);
    c.el.style.opacity = o.toFixed(4);
    const rise = (1 - smooth(c.a, c.a + 0.7, t)) * 1.6 * U;
    c.el.style.transform = `translateY(${rise.toFixed(2)}px)`;
  }
  const b3 = fadeIO(t, 16.4, 33.2), b1 = fadeIO(t, 42.4, DURATION + 1);
  badge.textContent = b1 > b3 ? '실제 비율 · 높이 과장 없음' : '높이를 3배 과장해 표시';
  badge.style.opacity = Math.max(b3, b1).toFixed(4);

  // 3D 꼬리표
  for (const g of tags) {
    const o = fadeIO(t, g.a, g.b, 0.5, 0.4);
    if (o <= 0.001) { g.el.style.opacity = 0; if (g.ln) g.ln.setAttribute('opacity', 0); continue; }
    const [px, py, front] = project(...g.pos);
    const lx = px + g.off[0] * U, ly = py + g.off[1] * U;
    const ax = g.align === 'left' ? '0%' : g.align === 'right' ? '-100%' : '-50%';
    g.el.style.opacity = front ? o.toFixed(4) : 0;
    g.el.style.transform = `translate(${lx.toFixed(2)}px, ${ly.toFixed(2)}px) translate(${ax}, -50%)`;
    g.el.style.textAlign = g.align;
    if (g.ln) {
      const len = Math.hypot(lx - px, ly - py) || 1;
      const k0 = (1.2 * U) / len, k1 = 1 - (g.off[0] === 0 ? 2.4 * U : 1.2 * U) / len;
      g.ln.setAttribute('x1', px + (lx - px) * k0); g.ln.setAttribute('y1', py + (ly - py) * k0);
      g.ln.setAttribute('x2', px + (lx - px) * k1); g.ln.setAttribute('y2', py + (ly - py) * k1);
      g.ln.setAttribute('stroke-width', 0.18 * U);
      g.ln.setAttribute('opacity', front ? o : 0);
    }
  }
  // 독도 고리
  {
    const o = Math.max(fadeIO(t, 7.2, 15.6, 0.6, 0.8), fadeIO(t, 36.0, 40.2, 0.5, 0.4));
    const [px, py] = project(0, 0.03, 0);
    const pulse = 1 + 0.12 * Math.sin(t * 3.2);
    const r = 3.0 * U * pulse;
    ringEl.style.opacity = o.toFixed(4);
    ringEl.style.width = ringEl.style.height = `${(2 * r).toFixed(2)}px`;
    ringEl.style.transform = `translate(${(px - r).toFixed(2)}px, ${(py - r).toFixed(2)}px)`;
  }
  return t;
}

// ───────────────────────── 실행 ─────────────────────────
buildCamera();
await document.fonts.load(`800 ${10 * U}px Pretendard`, '독도 해산');
await document.fonts.load(`600 ${3 * U}px Pretendard`, '독도 해산');
await document.fonts.load(`400 ${2 * U}px Pretendard`, '독도 해산');
await document.fonts.ready;

window.DURATION = DURATION;
/** 영상 렌더러가 부르는 함수: t 초의 장면을 그리고, 화면에 반영된 뒤 끝난다. */
window.renderFrame = (t) => new Promise((resolve) => {
  renderAt(t);
  requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)));
});
window.addEventListener('resize', () => { resize(); buildCamera(); renderAt(current); });

let current = Number(query.get('t') ?? 0);
if (query.has('t') || query.has('still')) {
  renderAt(current);
} else {
  // 미리보기: 실제 시간으로 반복 재생. 스페이스바로 멈춤, ←/→ 로 1초 이동.
  let playing = true, last = performance.now();
  window.addEventListener('keydown', (ev) => {
    if (ev.code === 'Space') playing = !playing;
    if (ev.code === 'ArrowRight') current = Math.min(DURATION, current + 1);
    if (ev.code === 'ArrowLeft') current = Math.max(0, current - 1);
  });
  const loop = (now) => {
    if (playing) current = (current + (now - last) / 1000) % DURATION;
    last = now;
    renderAt(current);
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}
window.sceneReady = true;
