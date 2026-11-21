#!/usr/bin/env python3
"""원본 수심 격자와 외곽선으로부터 3D 장면용 데이터 파일을 만든다.

사용법:  python3 tools/build_data.py raw data

입력 (tools/fetch_raw.sh 로 내려받는다)
  raw/gmrt_dokdo.asc   GMRT GridServer 수심 격자 (ESRI ASCII)
  raw/dokdo_osm.json   독도 해안선 폴리곤 (OpenStreetMap / Nominatim)
  raw/seoul_osm.json   서울특별시 경계 폴리곤 (OpenStreetMap / Nominatim)

출력
  data/terrain.bin     해저 지형 높이, int16 (0.1 m 단위), 북→남 행 순서
  data/islets.bin      독도 섬 모형: 높이 int16 (0.1 m) + 해안선 거리 int16 (0.1 m)
  data/scene.json      격자 정보, 외곽선, 계측값
"""
import heapq
import json
import sys
from pathlib import Path

import contourpy
import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage as ndi

RAW, OUT = Path(sys.argv[1]), Path(sys.argv[2])
OUT.mkdir(parents=True, exist_ok=True)

# 장면 원점: 동도와 서도 사이
LON0, LAT0 = 131.8662, 37.2417
# WGS84 타원체에서 위도 37.24° 의 1° 당 거리 (m)
M_LAT, M_LON = 110982.0, 88728.0

# 장면에 담을 범위 (원점 기준 km): 독도·심흥택·이사부 해산이 모두 들어간다
X_MIN, X_MAX = -41.0, 60.0      # 서(-) → 동(+)
Y_MIN, Y_MAX = -38.0, 36.0      # 남(-) → 북(+)

# 공식 제원 (독도: 외교부·경상북도 공표값)
DOKDO_AREA_M2 = 187_554
SEODO_PEAK_M, DONGDO_PEAK_M = 168.5, 98.6
BASE_DEPTH_M = 2000.0           # 해산 밑면으로 삼은 등심선
PLATFORM_DEPTH_M = 200.0        # 정상부 평탄면의 기준 수심


def load_asc(path):
    with open(path) as f:
        hdr = {}
        for _ in range(6):
            k, v = f.readline().split()
            hdr[k.lower()] = float(v)
        z = np.loadtxt(f, dtype=np.float32)
    nr, nc = z.shape
    cs = hdr['cellsize']
    lon = hdr['xllcorner'] + (np.arange(nc) + 0.5) * cs
    lat = hdr['yllcorner'] + (nr - 1 - np.arange(nr) + 0.5) * cs   # 0행 = 북쪽
    return z, lon, lat


def ring_area_km2(xy):
    x, y = xy[:, 0], xy[:, 1]
    return 0.5 * abs(np.dot(x, np.roll(y, -1)) - np.dot(y, np.roll(x, -1)))


def fbm(shape, rng, octaves=5, base=64):
    """부드러운 프랙탈 잡음 (0..1)."""
    out = np.zeros(shape, np.float32)
    amp, tot = 1.0, 0.0
    for o in range(octaves):
        step = max(2, base // (2 ** o))
        small = rng.random((shape[0] // step + 3, shape[1] // step + 3)).astype(np.float32)
        big = ndi.zoom(small, step, order=3)[:shape[0], :shape[1]]
        out += amp * big
        tot += amp
        amp *= 0.55
    out /= tot
    return (out - out.min()) / (out.max() - out.min())


# ───────────────────────── 1. 해저 지형 ─────────────────────────
z, lon, lat = load_asc(RAW / 'gmrt_dokdo.asc')
x_km = (lon - LON0) * M_LON / 1000.0
y_km = (lat - LAT0) * M_LAT / 1000.0
ci = np.nonzero((x_km >= X_MIN) & (x_km <= X_MAX))[0]
ri = np.nonzero((y_km >= Y_MIN) & (y_km <= Y_MAX))[0]
z = z[ri[0]:ri[-1] + 1, ci[0]:ci[-1] + 1].astype(np.float64)
x_km, y_km = x_km[ci], y_km[ri]
dx = (x_km[1] - x_km[0]) * 1000.0           # m
dy = (y_km[0] - y_km[1]) * 1000.0           # m (양수)
H, W = z.shape
print(f'terrain grid {W}x{H}, cell {dx:.1f} x {dy:.1f} m, '
      f'x {x_km[0]:.1f}..{x_km[-1]:.1f} km, y {y_km[-1]:.1f}..{y_km[0]:.1f} km')

z_raw = z.copy()
# 측량선 경계의 미세한 단차를 누그러뜨린다
z = ndi.gaussian_filter(z, 1.2)

# ───────────────────────── 2. 계측 ─────────────────────────
# 해산들을 서로 나누기 위해 봉우리에서부터 물을 채워 내려가는 방식(유역 분할)을 쓴다.
F = 4
zs = ndi.gaussian_filter(z_raw, 2)[::F, ::F]
xs_km, ys_km = x_km[::F], y_km[::F]
sdx, sdy = dx * F, dy * F
cell_km2 = sdx * sdy / 1e6
sm = ndi.gaussian_filter(zs, 2000 / sdx)
markers, n_mk = ndi.label(sm == ndi.maximum_filter(sm, size=int(6000 / sdx)))
labels = markers.copy()
heap = [(-zs[i, j], i, j) for i, j in zip(*np.nonzero(markers))]
heapq.heapify(heap)
h2, w2 = zs.shape
while heap:
    _, i, j = heapq.heappop(heap)
    for di, dj in ((1, 0), (-1, 0), (0, 1), (0, -1)):
        a, b = i + di, j + dj
        if 0 <= a < h2 and 0 <= b < w2 and labels[a, b] == 0:
            labels[a, b] = labels[i, j]
            heapq.heappush(heap, (-zs[a, b], a, b))
oi, oj = int(np.argmin(np.abs(ys_km))), int(np.argmin(np.abs(xs_km)))
dokdo_part = labels == labels[oi, oj]


def footprint(level):
    m = dokdo_part & (zs > level)
    lb, _ = ndi.label(m)
    return lb == lb[oi, oj]


def outline(mask, smooth=2.0):
    """마스크의 바깥 테두리를 매끈한 폴리라인(km)으로."""
    f = ndi.gaussian_filter(mask.astype(np.float32), smooth)
    gen = contourpy.contour_generator(xs_km, ys_km, f)
    lines = gen.lines(0.5)
    best = max(lines, key=len)
    step = max(1, len(best) // 400)
    return best[::step]


base_mask = footprint(-BASE_DEPTH_M)
plat_mask = footprint(-PLATFORM_DEPTH_M)
base_area = base_mask.sum() * cell_km2
plat_area = plat_mask.sum() * cell_km2
base_vol = ((zs[base_mask] + BASE_DEPTH_M) / 1000.0).sum() * cell_km2
by, bx = np.nonzero(base_mask)
base_ew = (bx.max() - bx.min()) * sdx / 1000
base_ns = (by.max() - by.min()) * sdy / 1000
base_cx = xs_km[bx].mean()
base_cy = ys_km[by].mean()

# 서쪽(다른 해산과 붙지 않은 쪽) 사면의 평균 단면: 경사가 3° 아래로 눕는 곳이 해산의 발치
prof = []
for r in np.arange(0, 26.0, 0.5):
    v = []
    for az in range(200, 341, 5):
        a = np.radians(az)
        ii = oi - int(round(r * 1000 * np.cos(a) / sdy))
        jj = oj + int(round(r * 1000 * np.sin(a) / sdx))
        if 0 <= ii < h2 and 0 <= jj < w2:
            v.append(zs[ii, jj])
    prof.append(float(np.mean(v)))
prof = np.array(prof)
slope = np.degrees(np.arctan(-np.diff(prof) / 500.0))
foot_idx = int(np.nonzero((slope < 3.0) & (np.arange(len(slope)) > 16))[0][0])
foot_r, foot_z = foot_idx * 0.5, prof[foot_idx]

# 이웃 해산의 꼭대기 위치
def summit_near(xk, yk, win_km=6.0):
    m = (np.abs(xs_km[None, :] - xk) < win_km) & (np.abs(ys_km[:, None] - yk) < win_km)
    k = np.argmax(np.where(m, zs, -9e9))
    i, j = np.unravel_index(k, zs.shape)
    return float(xs_km[j]), float(ys_km[i]), float(zs[i, j])

simheungtaek = summit_near(15.8, -9.2)
isabu = summit_near(43.4, -11.0)

total_height = BASE_DEPTH_M + SEODO_PEAK_M
# 물 위 부피의 상한: 면적 × 최고 높이 (실제는 이보다 훨씬 작다)
above_vol_max = DOKDO_AREA_M2 / 1e6 * SEODO_PEAK_M / 1000.0
facts = {
    'dokdo_area_km2': DOKDO_AREA_M2 / 1e6,
    'seodo_peak_m': SEODO_PEAK_M,
    'dongdo_peak_m': DONGDO_PEAK_M,
    'base_depth_m': BASE_DEPTH_M,
    'total_height_m': total_height,
    'base_area_km2': round(float(base_area), 1),
    'base_equiv_diameter_km': round(2 * np.sqrt(base_area / np.pi), 1),
    'base_extent_ew_km': round(base_ew, 1),
    'base_extent_ns_km': round(base_ns, 1),
    'base_centroid_km': [round(float(base_cx), 2), round(float(base_cy), 2)],
    'volume_above_base_km3': round(base_vol, 0),
    'above_water_volume_fraction_max': above_vol_max / base_vol,
    'platform_depth_m': PLATFORM_DEPTH_M,
    'platform_area_km2': round(plat_area, 1),
    'platform_equiv_diameter_km': round(2 * np.sqrt(plat_area / np.pi), 1),
    'area_ratio': round(base_area / (DOKDO_AREA_M2 / 1e6)),
    'west_flank_foot_radius_km': foot_r,
    'west_flank_foot_depth_m': round(-foot_z),
    'seoul_area_km2': 605.2,
    'hallasan_m': 1947,
    'lotte_tower_m': 555,
}
for k, v in facts.items():
    print(f'  {k}: {v}')

# ───────────────────────── 3. 독도 섬 모형 ─────────────────────────
# 해안선은 OpenStreetMap 실측 폴리곤, 높이는 공식 최고점에 맞춘 근사 모형이다.
osm = json.load(open(RAW / 'dokdo_osm.json'))
geo = next(e['geojson'] for e in osm if e['geojson']['type'] == 'MultiPolygon')
rings = []
for poly in geo['coordinates']:
    ll = np.array(poly[0], dtype=np.float64)
    rings.append(np.column_stack([(ll[:, 0] - LON0) * M_LON, (ll[:, 1] - LAT0) * M_LAT]))  # m
rings.sort(key=lambda r: -ring_area_km2(r / 1000.0))
areas_m2 = [ring_area_km2(r / 1000.0) * 1e6 for r in rings]
print(f'islet polygons {len(rings)}, OSM total area {sum(areas_m2):.0f} m2 '
      f'(largest {areas_m2[0]:.0f}, {areas_m2[1]:.0f})')

RES = 2.5                                   # m
allpts = np.vstack(rings)
MARGIN = 420.0
ix0, ix1 = allpts[:, 0].min() - MARGIN, allpts[:, 0].max() + MARGIN
iy0, iy1 = allpts[:, 1].min() - MARGIN, allpts[:, 1].max() + MARGIN
IW, IH = int((ix1 - ix0) / RES), int((iy1 - iy0) / RES)
ix1, iy1 = ix0 + IW * RES, iy0 + IH * RES
rng = np.random.default_rng(1905)

land = np.zeros((IH, IW), np.float32)
inside_any = np.zeros((IH, IW), bool)
n1 = fbm((IH, IW), rng, 6, 96)
n2 = fbm((IH, IW), rng, 5, 24)
gx_m = ix0 + (np.arange(IW) + 0.5) * RES
gy_m = iy1 - (np.arange(IH) + 0.5) * RES
# 가장 큰 두 폴리곤 가운데 서쪽이 서도
two = sorted(range(2), key=lambda k: rings[k][:, 0].mean())
peak_of = {two[0]: SEODO_PEAK_M, two[1]: DONGDO_PEAK_M}
for k, ring in enumerate(rings):
    im = Image.new('L', (IW, IH), 0)
    px = [((p[0] - ix0) / RES, (iy1 - p[1]) / RES) for p in ring]
    ImageDraw.Draw(im).polygon(px, fill=1)
    m = np.asarray(im, bool)
    if not m.any():
        continue
    inside_any |= m
    d = ndi.distance_transform_edt(m) * RES
    dmax = d.max()
    s = d / dmax
    pi_, pj_ = np.unravel_index(np.argmax(d), d.shape)
    if k in peak_of:
        peak = peak_of[k]
        rr = np.hypot(gx_m[None, :] - gx_m[pj_], gy_m[:, None] - gy_m[pi_])
        radial = np.clip(1 - rr / (2.3 * dmax), 0, 1)
        cliff = np.clip(s / 0.16, 0, 1) ** 0.8          # 해안 절벽
        if peak == SEODO_PEAK_M:                         # 서도: 뾰족한 원뿔형
            h = 0.22 * cliff + 0.78 * s ** 1.25 * (0.35 + 0.65 * radial ** 1.3)
        else:                                            # 동도: 비교적 평평한 꼭대기
            h = 0.42 * cliff + 0.58 * np.clip(s / 0.75, 0, 1) ** 1.1 * (0.55 + 0.45 * radial)
        h = h / h.max() * peak
        h *= 1 + 0.30 * (n1 - 0.5) * (1 - s ** 3)
        h += 6.0 * (n2 - 0.5) * np.clip(s * 4, 0, 1)
        h = h / h[m].max() * peak
    else:                                                # 부속 바위섬
        peak = min(0.9 * np.sqrt(areas_m2[k]), 34.0)
        h = peak * s ** 0.7 * (0.75 + 0.5 * n2)
    land = np.where(m, np.maximum(h, 0.6), land)
land = np.where(inside_any, ndi.gaussian_filter(land, 0.8), 0.0)
land = np.where(inside_any, np.maximum(land * (SEODO_PEAK_M / land.max()), 0.5), 0.0)

# 해안선까지의 부호 있는 거리 (바다 쪽 +, 땅 쪽 -)
d_out = ndi.distance_transform_edt(~inside_any) * RES
d_in = ndi.distance_transform_edt(inside_any) * RES
sdf = np.where(inside_any, -d_in, d_out)

# 본 격자에서 섬 부분(해상도가 낮아 뭉개진 덩어리)은 얕은 바다로 눌러 둔다
near = (np.abs(x_km[None, :]) < 1.3) & (np.abs(y_km[:, None]) < 1.3)
z = np.where(near, np.minimum(z, -12.0), z)
z = np.where(near, ndi.gaussian_filter(z, 2.0), z)

# 섬 주변 얕은 바닥: 해안에서 멀어질수록 깊어지다 본 격자 수심과 만난다
main_interp = ndi.map_coordinates(
    z, [(y_km[0] * 1000 - gy_m[:, None]) / dy + 0 * gx_m[None, :],
        (gx_m[None, :] - x_km[0] * 1000) / dx + 0 * gy_m[:, None]], order=1, mode='nearest')
seabed = np.maximum(main_interp, -1.0 - 0.33 * d_out)
islet_h = np.where(inside_any, land, seabed).astype(np.float32)
print(f'islet grid {IW}x{IH} @ {RES} m, peak {islet_h.max():.1f} m, '
      f'model volume above sea {land.sum() * RES * RES / 1e9:.4f} km3')
facts['above_water_volume_model_km3'] = round(float(land.sum() * RES * RES / 1e9), 4)

# ───────────────────────── 4. 저장 ─────────────────────────
np.clip(np.round(z * 10), -32768, 32767).astype('<i2').tofile(OUT / 'terrain.bin')
np.concatenate([
    np.clip(np.round(islet_h * 10), -32768, 32767).astype('<i2').ravel(),
    np.clip(np.round(sdf * 10), -32768, 32767).astype('<i2').ravel(),
]).tofile(OUT / 'islets.bin')

seoul = json.load(open(RAW / 'seoul_osm.json'))[0]['geojson']
ring = np.array(seoul['coordinates'][0], dtype=np.float64)
phi = np.radians(ring[:, 1].mean())
m_lon_s = 111412.84 * np.cos(phi) - 93.5 * np.cos(3 * phi)
m_lat_s = 111132.92 - 559.82 * np.cos(2 * phi) + 1.175 * np.cos(4 * phi)
sx = (ring[:, 0] - (ring[:, 0].min() + ring[:, 0].max()) / 2) * m_lon_s / 1000
sy = (ring[:, 1] - (ring[:, 1].min() + ring[:, 1].max()) / 2) * m_lat_s / 1000
seoul_xy = np.column_stack([sx, sy])
print(f'seoul outline {len(seoul_xy)} pts, polygon area {ring_area_km2(seoul_xy):.1f} km2, '
      f'extent {np.ptp(sx):.1f} x {np.ptp(sy):.1f} km')
facts['seoul_extent_km'] = [round(float(np.ptp(sx)), 1), round(float(np.ptp(sy)), 1)]

r3 = lambda a: [[round(float(p[0]), 3), round(float(p[1]), 3)] for p in a]
scene = {
    'origin': {'lon': LON0, 'lat': LAT0},
    'terrain': {'w': W, 'h': H, 'x0': float(x_km[0]), 'x1': float(x_km[-1]),
                'y0': float(y_km[-1]), 'y1': float(y_km[0]), 'dx_m': dx, 'dy_m': dy,
                'min_m': float(z.min()), 'max_m': float(z.max())},
    'islets': {'w': IW, 'h': IH, 'x0': ix0 / 1000, 'x1': ix1 / 1000,
               'y0': iy0 / 1000, 'y1': iy1 / 1000, 'res_m': RES},
    'outlines': {
        'base': r3(outline(base_mask)),
        'platform': r3(outline(plat_mask, 1.2)),
        'seoul': r3(seoul_xy),
        'islets': [r3(r / 1000.0) for r in rings[:2]],
    },
    'summits': {
        'dokdo': [0.0, 0.0, SEODO_PEAK_M],
        'simheungtaek': [round(v, 2) for v in simheungtaek],
        'isabu': [round(v, 2) for v in isabu],
    },
    'facts': facts,
}
json.dump(scene, open(OUT / 'scene.json', 'w'), ensure_ascii=False, indent=1)
print('wrote', [p.name for p in sorted(OUT.iterdir())])
