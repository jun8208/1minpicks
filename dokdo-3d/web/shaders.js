// 장면에 쓰는 GLSL 셰이더 모음.

const COMMON = /* glsl */`
uniform sampler2D uH;        // 해저 지형 높이 (m)
uniform vec2 uOrigin;        // 격자 첫 칸의 (x, z) km
uniform vec2 uCell;          // 격자 한 칸의 크기 km
uniform vec2 uSize;          // 격자 칸 수
uniform sampler2D uIH;       // 독도 섬 모형: R 높이(m), G 해안선까지 거리(m, 바다 쪽 +)
uniform vec2 uIOrigin;
uniform vec2 uICell;
uniform vec2 uISize;
uniform vec3 uSun;
uniform vec3 uFogColor;
uniform float uFog;          // km 당 안개 밀도

vec2 terrUv(vec2 xz) { return ((xz - uOrigin) / uCell + 0.5) / uSize; }
vec2 isletUv(vec2 xz) { return ((xz - uIOrigin) / uICell + 0.5) / uISize; }

vec4 bilinear(sampler2D t, vec2 uv) {
  ivec2 sz = textureSize(t, 0);
  vec2 p = uv * vec2(sz) - 0.5;
  vec2 f = fract(p);
  ivec2 i = ivec2(floor(p));
  ivec2 mx = sz - 1;
  vec4 a = texelFetch(t, clamp(i, ivec2(0), mx), 0);
  vec4 b = texelFetch(t, clamp(i + ivec2(1, 0), ivec2(0), mx), 0);
  vec4 c = texelFetch(t, clamp(i + ivec2(0, 1), ivec2(0), mx), 0);
  vec4 d = texelFetch(t, clamp(i + ivec2(1, 1), ivec2(0), mx), 0);
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

float hash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
}
float fbm(vec2 p) {
  float s = 0.0, a = 0.5;
  for (int k = 0; k < 5; k++) { s += a * vnoise(p); p = p * 2.03 + 17.1; a *= 0.5; }
  return s;
}
vec3 applyFog(vec3 col, vec3 world) {
  float d = distance(world, cameraPosition);
  return mix(col, uFogColor, 1.0 - exp(-d * uFog));
}
`;

const VERT = /* glsl */`
varying vec3 vPos;
varying vec3 vWorld;
varying vec3 vNormal;
void main() {
  vPos = position;
  vNormal = normal;
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

// ───────────── 해저 지형 ─────────────
const TERRAIN_FRAG = /* glsl */`
${COMMON}
uniform float uShadeVE;
uniform float uContour;
varying vec3 vPos;
varying vec3 vWorld;

vec3 ramp(float h) {
  vec3 c = vec3(0.070, 0.105, 0.300);
  c = mix(c, vec3(0.080, 0.190, 0.470), smoothstep(-2400.0, -1950.0, h));
  c = mix(c, vec3(0.085, 0.340, 0.640), smoothstep(-1950.0, -1350.0, h));
  c = mix(c, vec3(0.100, 0.540, 0.700), smoothstep(-1350.0, -750.0, h));
  c = mix(c, vec3(0.300, 0.740, 0.680), smoothstep(-750.0, -260.0, h));
  c = mix(c, vec3(0.790, 0.870, 0.650), smoothstep(-260.0, -70.0, h));
  c = mix(c, vec3(0.930, 0.870, 0.680), smoothstep(-70.0, 0.0, h));
  return c;
}
float isoline(float h, float stepM, float w) {
  float v = h / stepM;
  float fw = max(fwidth(v), 1e-6);
  float d = abs(fract(v - 0.5) - 0.5) / fw;
  return (1.0 - smoothstep(w - 0.5, w + 0.5, d)) * (1.0 - smoothstep(0.22, 0.55, fw));
}
void main() {
  vec2 uv = terrUv(vPos.xz);
  vec2 tx = 1.0 / uSize;
  float h = bilinear(uH, uv).r;
  float hl = bilinear(uH, uv - vec2(tx.x, 0.0)).r;
  float hr = bilinear(uH, uv + vec2(tx.x, 0.0)).r;
  float hu = bilinear(uH, uv - vec2(0.0, tx.y)).r;
  float hd = bilinear(uH, uv + vec2(0.0, tx.y)).r;
  float gx = (hr - hl) / (2000.0 * uCell.x);
  float gz = (hd - hu) / (2000.0 * uCell.y);
  vec3 n = normalize(vec3(-gx * uShadeVE, 1.0, -gz * uShadeVE));

  vec3 base = ramp(h);
  float minor = isoline(h, 250.0, 0.9);
  float major = isoline(h, 1000.0, 1.4);
  // 거의 평평한 해저분지에서는 등심선이 제멋대로 구불거리므로 경사가 있는 곳에만 긋는다
  float steep = smoothstep(0.03, 0.08, length(vec2(gx, gz)));
  base = mix(base, base * 0.72, minor * 0.55 * uContour * steep);
  base = mix(base, vec3(0.92, 0.98, 1.0), major * 0.30 * uContour * steep);

  float ndl = dot(n, uSun);
  float diff = clamp(ndl * 0.6 + 0.4, 0.0, 1.0);
  diff = diff * diff;
  vec3 amb = mix(vec3(0.20, 0.25, 0.42), vec3(0.62, 0.74, 0.95), n.y * 0.5 + 0.5) * 0.62;
  vec3 col = base * (amb + vec3(1.08, 1.02, 0.92) * diff * 1.05);
  // 경사가 급한 곳은 살짝 어둡게 해서 골짜기를 살린다
  col *= mix(0.80, 1.0, smoothstep(0.55, 1.0, n.y));
  gl_FragColor = vec4(applyFog(col, vWorld), 1.0);
}
`;

// ───────────── 지형 덩어리의 옆면(단면) ─────────────
const SKIRT_FRAG = /* glsl */`
${COMMON}
varying vec3 vPos;
varying vec3 vWorld;
varying vec3 vNormal;
void main() {
  float h = vPos.y * 1000.0;
  float band = smoothstep(0.42, 0.5, abs(fract(h / 250.0) - 0.5));
  vec3 col = mix(vec3(0.085, 0.115, 0.215), vec3(0.150, 0.190, 0.320), smoothstep(-2800.0, -400.0, h));
  col *= mix(1.0, 0.86, band);
  float lit = 0.72 + 0.28 * max(dot(normalize(vNormal), normalize(vec3(uSun.x, 0.0, uSun.z))), 0.0);
  gl_FragColor = vec4(applyFog(col * lit, vWorld), 1.0);
}
`;

// ───────────── 독도 섬 ─────────────
const ISLET_FRAG = /* glsl */`
${COMMON}
varying vec3 vPos;
varying vec3 vWorld;
void main() {
  vec2 uv = isletUv(vPos.xz);
  vec2 tx = 1.0 / uISize;
  float h = bilinear(uIH, uv).r;
  if (h < -5.0) discard;
  float hl = bilinear(uIH, uv - vec2(tx.x, 0.0)).r;
  float hr = bilinear(uIH, uv + vec2(tx.x, 0.0)).r;
  float hu = bilinear(uIH, uv - vec2(0.0, tx.y)).r;
  float hd = bilinear(uIH, uv + vec2(0.0, tx.y)).r;
  float gx = (hr - hl) / (2000.0 * uICell.x);
  float gz = (hd - hu) / (2000.0 * uICell.y);
  // 높이를 과장해도 섬의 명암은 실제 경사대로 둔다 (과장하면 온통 절벽이 되어 새까매진다)
  vec3 nTrue = normalize(vec3(-gx, 1.0, -gz));
  vec3 n = nTrue;

  vec2 m = vPos.xz * 1000.0;                      // m
  float n1 = fbm(m * 0.045);
  float n2 = fbm(m * 0.21 + 31.0);
  float strata = vnoise(vec2(h * 0.22 + n1 * 3.0, n1 * 2.0));
  vec3 rock = mix(vec3(0.36, 0.33, 0.31), vec3(0.60, 0.55, 0.48), n2);
  rock = mix(rock, vec3(0.47, 0.40, 0.34), strata * 0.45);
  float veg = smoothstep(0.62, 0.82, nTrue.y) * smoothstep(14.0, 34.0, h) * smoothstep(0.34, 0.60, n1 + 0.25 * n2);
  vec3 col = mix(rock, vec3(0.34, 0.43, 0.22) * (0.8 + 0.4 * n2), veg);
  col = mix(vec3(0.17, 0.17, 0.18), col, smoothstep(0.5, 5.0, h));      // 물에 젖은 바위
  col = mix(vec3(0.10, 0.22, 0.26), col, smoothstep(-5.0, 0.3, h));

  float ndl = dot(n, uSun);
  float diff = clamp(ndl * 0.75 + 0.25, 0.0, 1.0);
  diff = diff * diff;
  vec3 amb = mix(vec3(0.24, 0.27, 0.36), vec3(0.58, 0.68, 0.84), n.y * 0.5 + 0.5) * 0.66;
  col = col * (amb + vec3(1.15, 1.06, 0.92) * diff * 1.15);
  gl_FragColor = vec4(applyFog(col, vWorld), 1.0);
}
`;

// ───────────── 바다 윗면 ─────────────
const WATER_FRAG = /* glsl */`
${COMMON}
uniform float uTime;
uniform float uAlpha;        // 깊은 바다의 불투명도
uniform float uReflect;      // 하늘 반사 세기
uniform float uOpacity;      // 전체 페이드
uniform vec3 uSkyZ;
uniform vec3 uSkyH;
uniform vec3 uDeep;
uniform vec3 uShallow;
varying vec3 vPos;
varying vec3 vWorld;

vec2 waveGrad(vec2 p, float px) {
  vec2 g = vec2(0.0);
  // 방향, 파장(km), 기울기, 속도
  #define WAVE(dx, dz, L, s, sp) { vec2 d = normalize(vec2(dx, dz)); float fade = 1.0 - smoothstep(0.10, 0.40, px / L); float amp = 0.45 + 1.1 * vnoise(p * (0.41 / L) + vec2(dx * 13.0, dz * 7.0)); g += d * cos(dot(d, p) * 6.2831853 / L + uTime * sp + 5.0 * w1 + 3.0 * w2) * s * fade * amp; }
  // 물마루가 일직선으로 늘어서지 않도록 위상과 세기를 잡음으로 흩뜨린다
  float w1 = vnoise(p * 3.1 + vec2(uTime * 0.03, 0.0));
  float w2 = vnoise(p * 7.3 - vec2(0.0, uTime * 0.05));
  WAVE( 1.0,  0.35, 0.210, 0.050, 0.90)
  WAVE( 0.8, -0.55, 0.130, 0.045, 1.15)
  WAVE( 0.3,  1.00, 0.083, 0.050, 1.45)
  WAVE(-0.6,  0.80, 0.047, 0.050, 1.90)
  WAVE( 1.0, -0.15, 0.029, 0.045, 2.40)
  WAVE( 0.2, -1.00, 0.017, 0.040, 3.00)
  WAVE( 1.0,  0.45, 9.000, 0.030, 0.35)
  WAVE(-0.4,  1.00, 5.300, 0.028, 0.45)
  WAVE( 0.9, -0.60, 2.700, 0.024, 0.60)
  WAVE( 0.1,  1.00, 1.300, 0.020, 0.80)
  // 잔물결
  float e = 0.0035;
  vec2 cp = p * 55.0 + uTime * vec2(0.45, 0.28);
  float c0 = fbm(cp);
  float chop = 1.0 - smoothstep(0.0015, 0.007, px);
  g += vec2(fbm(cp + vec2(e * 55.0, 0.0)) - c0, fbm(cp + vec2(0.0, e * 55.0)) - c0) / e * 0.0028 * chop;
  return g;
}
void main() {
  vec3 V = normalize(cameraPosition - vWorld);
  float px = length(fwidth(vWorld.xz));
  vec2 g = waveGrad(vWorld.xz, px);
  vec3 n = normalize(vec3(-g.x, 1.0, -g.y));

  float sdf = 1.0e4;
  vec2 iuv = isletUv(vPos.xz);
  if (iuv.x > 0.0 && iuv.x < 1.0 && iuv.y > 0.0 && iuv.y < 1.0) sdf = bilinear(uIH, iuv).g;
  float shallow = 1.0 - smoothstep(0.0, 70.0, sdf);

  vec3 R = reflect(-V, n);
  R.y = abs(R.y);
  vec3 sky = mix(uSkyH, uSkyZ, pow(clamp(R.y, 0.0, 1.0), 0.55));
  float F = 0.02 + 0.98 * pow(1.0 - clamp(dot(n, V), 0.0, 1.0), 5.0);
  float sd = max(dot(R, uSun), 0.0);
  float spec = pow(sd, 420.0) * 2.6 + pow(sd, 36.0) * 0.10;

  vec3 body = mix(uDeep, uShallow, shallow * 0.85);
  body *= 0.90 + 0.20 * clamp(dot(n, uSun), 0.0, 1.0);
  vec3 col = mix(body, sky, clamp(F * uReflect, 0.0, 1.0)) + vec3(1.0, 0.97, 0.90) * spec * uReflect;

  float wob = vnoise(vPos.xz * 1000.0 * 0.11 + vec2(uTime * 0.6, -uTime * 0.4));
  float foam = (1.0 - smoothstep(1.0, 5.5 + 7.0 * wob, sdf)) * step(-2.5, sdf);
  foam = max(foam, (1.0 - smoothstep(0.0, 30.0, sdf)) * smoothstep(0.62, 0.9, wob) * 0.6);
  col = mix(col, vec3(0.96, 0.98, 1.0), foam * 0.9);

  float a = uAlpha * mix(1.0, 0.62, shallow);
  a = clamp(a + F * uReflect * 0.7 + spec * uReflect + foam * 0.9, 0.0, 1.0);
  float fog = 1.0 - exp(-distance(vWorld, cameraPosition) * uFog);
  col = mix(col, uFogColor, fog);
  a = mix(a, 1.0, fog);
  gl_FragColor = vec4(col, a * uOpacity);
}
`;

// ───────────── 바다 옆면 ─────────────
const WATERSIDE_FRAG = /* glsl */`
${COMMON}
uniform float uAlpha;
varying vec3 vPos;
varying vec3 vWorld;
void main() {
  float d = clamp(-vPos.y / 2.4, 0.0, 1.0);
  vec3 col = mix(vec3(0.150, 0.470, 0.780), vec3(0.030, 0.105, 0.300), pow(d, 0.7));
  float edge = 1.0 - smoothstep(0.0, 0.035, -vPos.y);
  col = mix(col, vec3(0.55, 0.85, 1.0), edge * 0.5);
  gl_FragColor = vec4(applyFog(col, vWorld), clamp(uAlpha + edge * 0.25, 0.0, 1.0));
}
`;

// ───────────── 계단 현상 제거 (FXAA) ─────────────
// 투명한 배경 위에 그리므로 알파까지 네 채널을 함께 섞는다.
const FXAA_FRAG = /* glsl */`
uniform sampler2D tDiffuse;
uniform vec2 uRes;
float lumaOf(vec4 c) { return dot(c.rgb, vec3(0.299, 0.587, 0.114)) + c.a * 0.25; }
void main() {
  vec2 inv = 1.0 / uRes;
  vec2 uv = gl_FragCoord.xy * inv;
  vec4 m = texture2D(tDiffuse, uv);
  float lNW = lumaOf(texture2D(tDiffuse, uv + vec2(-1.0, -1.0) * inv));
  float lNE = lumaOf(texture2D(tDiffuse, uv + vec2(1.0, -1.0) * inv));
  float lSW = lumaOf(texture2D(tDiffuse, uv + vec2(-1.0, 1.0) * inv));
  float lSE = lumaOf(texture2D(tDiffuse, uv + vec2(1.0, 1.0) * inv));
  float lM = lumaOf(m);
  float lMin = min(lM, min(min(lNW, lNE), min(lSW, lSE)));
  float lMax = max(lM, max(max(lNW, lNE), max(lSW, lSE)));
  vec2 dir = vec2(-((lNW + lNE) - (lSW + lSE)), (lNW + lSW) - (lNE + lSE));
  float reduce = max((lNW + lNE + lSW + lSE) * 0.03125, 0.0078125);
  float rcp = 1.0 / (min(abs(dir.x), abs(dir.y)) + reduce);
  dir = clamp(dir * rcp, vec2(-8.0), vec2(8.0)) * inv;
  vec4 a = 0.5 * (texture2D(tDiffuse, uv + dir * (1.0 / 3.0 - 0.5)) + texture2D(tDiffuse, uv + dir * (2.0 / 3.0 - 0.5)));
  vec4 b = a * 0.5 + 0.25 * (texture2D(tDiffuse, uv - dir * 0.5) + texture2D(tDiffuse, uv + dir * 0.5));
  float lB = lumaOf(b);
  gl_FragColor = (lB < lMin || lB > lMax) ? a : b;
}
`;

export { VERT, TERRAIN_FRAG, SKIRT_FRAG, ISLET_FRAG, WATER_FRAG, WATERSIDE_FRAG, FXAA_FRAG };
