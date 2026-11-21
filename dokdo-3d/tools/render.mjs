// 장면을 한 프레임씩 그려 영상(MP4)으로 만든다.
//
//   node tools/render.mjs                     가로 1920x1080 영상
//   node tools/render.mjs --aspect 9x16       세로 1080x1920 영상 (쇼츠·릴스용)
//   node tools/render.mjs --stills 3,12,24    해당 시각(초)의 정지 화면만 PNG 로
//
// 옵션: --fps 30  --scale 1  --workers 2  --from 0  --to <끝>  --out <파일>
//       --keep-frames   프레임 PNG 를 지우지 않고 남겨 둔다
//       --patch         남겨 둔 프레임 가운데 --from ~ --to 구간만 다시 그려 전체를 다시 인코딩한다
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from './serve.mjs';

// playwright 는 이 프로젝트에 설치돼 있든 전역(NODE_PATH)에 있든 찾아 쓴다
const { chromium } = createRequire(import.meta.url)('playwright');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = Object.fromEntries(process.argv.slice(2).join(' ').split('--').filter(Boolean).map((s) => {
  const [k, ...v] = s.trim().split(/\s+/);
  return [k, v.length ? v.join(' ') : true];
}));
const aspect = args.aspect || '16x9';
const scale = Number(args.scale || 1);
const [W, H] = (aspect === '9x16' ? [1080, 1920] : [1920, 1080]).map((v) => Math.round(v * scale / 2) * 2);
const fps = Number(args.fps || 30);
const workers = Number(args.workers || 2);          // 소프트웨어 렌더러는 이미 코어를 다 쓰므로 더 늘려도 빨라지지 않는다
const outDir = path.join(ROOT, 'out');
const frameDir = path.join(outDir, `frames_${aspect}`);

const server = await serve(0);
const url = `http://127.0.0.1:${server.address().port}/web/index.html?still=1`;
const launch = () => chromium.launch({
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-webgl', '--hide-scrollbars'],
});
async function openPage(browser) {
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log(`[page ${m.type()}]`, m.text()); });
  page.on('pageerror', (e) => console.log('[page error]', e.message));
  await page.goto(url);
  await page.waitForFunction('window.sceneReady === true', null, { timeout: 120000 });
  return page;
}

await mkdir(outDir, { recursive: true });
try {
  if (args.stills) {
    const browser = await launch();
    const page = await openPage(browser);
    for (const t of String(args.stills).split(',').map(Number)) {
      const t0 = Date.now();
      await page.evaluate((tt) => window.renderFrame(tt), t);
      const file = path.join(outDir, `still_${aspect}_${t.toFixed(1).padStart(4, '0')}.png`);
      await page.screenshot({ path: file });
      console.log(`${file}  (${Date.now() - t0} ms)`);
    }
    await browser.close();
  } else {
    const duration = await (async () => {
      const b = await launch(); const p = await openPage(b);
      const d = await p.evaluate('window.DURATION'); await b.close(); return d;
    })();
    const first = Math.round(Number(args.from || 0) * fps);
    const last = Math.round(Number(args.to || duration) * fps);       // 끝 프레임은 포함하지 않는다
    if (!args.patch) await rm(frameDir, { recursive: true, force: true });
    await mkdir(frameDir, { recursive: true });
    const total = last - first;
    let next = first, done = 0;
    const started = Date.now();
    console.log(`${aspect} ${W}x${H} @ ${fps} fps, frames ${first}..${last - 1} (${total}), ${workers} workers`);
    await Promise.all(Array.from({ length: workers }, async () => {
      const browser = await launch();
      const page = await openPage(browser);
      while (next < last) {
        const f = next++;
        await page.evaluate((tt) => window.renderFrame(tt), f / fps);
        const buf = await page.screenshot({ type: 'png' });
        await writeFile(path.join(frameDir, `${String(f).padStart(5, '0')}.png`), buf);
        if (++done % 60 === 0 || done === total) {
          const el = (Date.now() - started) / 1000;
          console.log(`  ${done}/${total}  ${(el / done).toFixed(2)} s/frame  remaining ~${Math.round(el / done * (total - done))} s`);
        }
      }
      await browser.close();
    }));
    const out = path.resolve(args.out || path.join(outDir, `dokdo_seamount_${aspect}.mp4`));
    await new Promise((resolve, reject) => {
      const ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(fps),
        '-start_number', String(args.patch ? 0 : first), '-i', path.join(frameDir, '%05d.png'),
        '-c:v', 'libx264', '-preset', 'slow', '-crf', '17', '-pix_fmt', 'yuv420p',
        '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', '-movflags', '+faststart', out], { stdio: 'inherit' });
      ff.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited with ${code}`))));
    });
    if (!args['keep-frames'] && !args.patch) await rm(frameDir, { recursive: true, force: true });
    console.log(`wrote ${out}`);
  }
} finally {
  server.close();
}
