#!/usr/bin/env node
// Renders the world canvas proof screenshots with headless Chromium.
//   BASE=http://127.0.0.1:3100 node scripts/world-screens.mjs [--set public|arcanea|all] [--out <dir>]
// Needs a running app; the arcanea set also needs arcanea.world.json in the world dir.
// PW_CHROMIUM=/path/to/chrome uses a preinstalled browser when the pinned build is missing.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { chromium } from '@playwright/test';

const base = process.env.BASE ?? 'http://127.0.0.1:3100';
const args = process.argv.slice(2);
const outIdx = args.indexOf('--out');
const out = path.resolve(outIdx >= 0 ? args[outIdx + 1] : '../../docs/design/world-canvas/screens');
mkdirSync(out, { recursive: true });

const TEN_GATES = 'r_the-ten-gates_06arsezx3ua';
const MALACHAR = 'n_malachar_01qhk55994a';

// `public` shots use the synthetic 10k world only, so they can live in this public repo.
// `arcanea` shots show private world content (spec section 7) and belong in frankxai/arcanea-world-graph.
const setIdx = args.indexOf('--set');
const set = setIdx >= 0 ? args[setIdx + 1] : 'public';
const publicShots = [
  { name: 'stress-10k-cluster', url: '/world/stress', expectLevel: 'cluster' },
  { name: 'stress-10k-card', url: '/world/stress?at=3000,2400&zoom=0.55', expectLevel: 'card' },
  { name: 'stress-10k-full-inspector', url: '/world/stress?node=n_gen_4321&zoom=1.5', mobileUrl: '/world/stress?node=n_gen_4321&zoom=1.3', expectLevel: 'full', inspector: true },
];
const arcaneaShots = [
  { name: 'arcanea-cluster', url: '/world/arcanea', expectLevel: 'cluster' },
  { name: 'arcanea-ten-gates-card', url: `/world/arcanea?region=${TEN_GATES}&zoom=0.5`, mobileUrl: '/world/arcanea?at=3400,1700&zoom=0.42', expectLevel: 'card' },
  { name: 'arcanea-character-full-inspector', url: `/world/arcanea?node=${MALACHAR}&zoom=1.5`, mobileUrl: `/world/arcanea?node=${MALACHAR}&zoom=1.25`, expectLevel: 'full', inspector: true },
];
const shots = set === 'arcanea' ? arcaneaShots : set === 'all' ? [...arcaneaShots, ...publicShots] : publicShots;

const viewports = [
  { id: '1440x900', width: 1440, height: 900 },
  { id: '390x844', width: 390, height: 844, mobile: true },
];

const browser = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
const manifest = [];
let failures = 0;
for (const vp of viewports) {
  const context = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    deviceScaleFactor: 1,
    isMobile: Boolean(vp.mobile),
    hasTouch: Boolean(vp.mobile),
  });
  for (const shot of shots) {
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(base + ((vp.mobile && shot.mobileUrl) || shot.url), { waitUntil: 'networkidle' });
    await page.waitForFunction(() => Number(document.querySelector('.wc')?.getAttribute('data-total-nodes') ?? 0) > 0, null, { timeout: 30_000 });
    if (shot.inspector) await page.waitForSelector('.wc-inspector', { timeout: 10_000 });
    await page.waitForTimeout(900);
    const state = await page.evaluate(() => {
      const el = document.querySelector('.wc');
      return {
        level: el?.getAttribute('data-level'),
        rendered: Number(el?.getAttribute('data-rendered-nodes')),
        total: Number(el?.getAttribute('data-total-nodes')),
        domNodes: document.querySelectorAll('.react-flow__node').length,
      };
    });
    const file = `${shot.name}-${vp.id}.png`;
    await page.screenshot({ path: path.join(out, file) });
    const ok = state.level === shot.expectLevel && errors.length === 0;
    if (!ok) failures += 1;
    manifest.push({ file, url: (vp.mobile && shot.mobileUrl) || shot.url, ...state, expectLevel: shot.expectLevel, ok, errors });
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${file} level=${state.level} rendered=${state.rendered}/${state.total} dom=${state.domNodes}${errors.length ? ` errors=${errors.join(' | ')}` : ''}`);
    await page.close();
  }
  await context.close();
}

// Pan and zoom the 10k stress world at card level and count animation frames.
const perfCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const perf = await perfCtx.newPage();
await perf.goto(`${base}/world/stress?at=3000,2400&zoom=0.6`, { waitUntil: 'networkidle' });
await perf.waitForFunction(() => Number(document.querySelector('.wc')?.getAttribute('data-rendered-nodes') ?? 0) > 0);
await perf.click('.wc-inspector button[aria-label="Close inspector"]').catch(() => {});
await perf.evaluate(() => {
  window.__frames = [];
  const tick = (t) => {
    window.__frames.push(t);
    if (window.__frames.length < 100_000) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
});
const start = Date.now();
await perf.mouse.move(700, 450);
await perf.mouse.down();
for (let i = 0; i < 120; i++) await perf.mouse.move(700 - i * 12, 450 - i * 5);
await perf.mouse.up();
for (let i = 0; i < 20; i++) await perf.mouse.wheel(0, i < 10 ? -120 : 120);
const elapsed = Date.now() - start;
const perfStats = await perf.evaluate(() => {
  const f = window.__frames;
  const gaps = f.slice(1).map((t, i) => t - f[i]).sort((a, b) => a - b);
  const p = (q) => gaps[Math.min(gaps.length - 1, Math.floor(gaps.length * q))];
  return {
    frames: f.length,
    avgFps: Math.round((f.length - 1) / ((f[f.length - 1] - f[0]) / 1000)),
    p50Ms: Math.round(p(0.5) * 10) / 10,
    p95Ms: Math.round(p(0.95) * 10) / 10,
    maxMs: Math.round(gaps[gaps.length - 1] * 10) / 10,
    rendered: Number(document.querySelector('.wc')?.getAttribute('data-rendered-nodes')),
    domNodes: document.querySelectorAll('.react-flow__node').length,
  };
});
console.log(`perf stress-10k pan+zoom ${elapsed}ms: ${JSON.stringify(perfStats)}`);
await perfCtx.close();
await browser.close();

writeFileSync(path.join(out, 'manifest.json'), `${JSON.stringify({ base, generatedAt: new Date().toISOString(), shots: manifest, perf: perfStats }, null, 2)}\n`);
process.exit(failures ? 1 : 0);
