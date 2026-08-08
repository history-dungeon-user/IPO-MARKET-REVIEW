// Screenshot harness: serves the game, drives it via window.__SKYWARD__, and
// captures gameplay frames for visual review. Usage: node tools/shoot.mjs [outDir]
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.resolve(process.argv[2] || path.join(ROOT, 'shots'));
fs.mkdirSync(OUT, { recursive: true });

const MIME = { '.html':'text/html', '.js':'text/javascript', '.mjs':'text/javascript', '.json':'application/json', '.css':'text/css', '.png':'image/png', '.wasm':'application/wasm' };

function serve() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let p = decodeURIComponent(req.url.split('?')[0]);
      if (p === '/') p = '/index.html';
      const fp = path.join(ROOT, p);
      if (!fp.startsWith(ROOT) || !fs.existsSync(fp) || fs.statSync(fp).isDirectory()) {
        res.writeHead(404); res.end('nf'); return;
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' });
      fs.createReadStream(fp).pipe(res);
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// portrait phone viewport (iPhone-ish) — the primary target
const VIEW = { width: 440, height: 950 };

async function main() {
  const server = await serve();
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}/index.html`;

  const browser = await chromium.launch({
    executablePath: CHROME,
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--no-sandbox'],
  });
  const page = await browser.newPage({ viewport: VIEW, deviceScaleFactor: 2 });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console:' + m.text()); });
  page.on('pageerror', (e) => errors.push('pageerror:' + e.message));

  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__SKYWARD__ && window.__SKYWARD__.postfx, null, { timeout: 15000 });
  await sleep(900);

  const shot = (name) => page.screenshot({ path: path.join(OUT, name + '.png') });

  // 1) Menu / title
  await shot('01_menu');

  // 2) Start & climb a curated run. We advance by feeding the CORRECT direction
  // so we get deep, photogenic frames rather than an instant fall.
  await page.evaluate(() => window.__SKYWARD__.startGame());
  await sleep(400);

  async function step1(pg) {
    // wait until idle, then feed the correct direction (deliberate play)
    await pg.waitForFunction(() => {
      const g = window.__SKYWARD__;
      return g.state !== 'playing' || g.player.state === 'idle';
    }, null, { timeout: 4000 }).catch(() => {});
    await pg.evaluate(() => {
      const g = window.__SKYWARD__;
      if (g.state !== 'playing') return;
      const req = g.stairs.requiredDir(g.playerIndex);
      g.onAction(g.buttonForDir(req));
    });
    await sleep(70);
  }
  async function climb(n, pg = page) { for (let i = 0; i < n; i++) await step1(pg); }

  await climb(6);  await sleep(300); await shot('02_early');
  await climb(10); await sleep(300); await shot('03_climbing');
  await climb(14); await sleep(200); await shot('04_combo');
  await climb(20); await sleep(300); await shot('05_deep');

  // force a game-over to capture the overlay
  await page.evaluate(() => { const g = window.__SKYWARD__; const r = g.stairs.requiredDir(g.playerIndex); g.onAction(g.buttonForDir(r) === 'right' ? 'left' : 'right'); });
  await sleep(2600); await shot('07_gameover');

  // wide landscape frame too (tablet / hero shot)
  // Landscape hero shot — reuse the SAME page (a 2nd WebGL context is flaky
  // under software rendering) by just resizing the viewport.
  try {
    await page.setViewportSize({ width: 1180, height: 620 });
    await sleep(500);
    await climb(6);
    await sleep(400);
    await page.screenshot({ path: path.join(OUT, '06_hero_wide.png') });
  } catch (e) { console.log('wide shot skipped:', e.message); }

  fs.writeFileSync(path.join(OUT, 'errors.json'), JSON.stringify(errors, null, 2));
  console.log('shots written to', OUT);
  console.log('runtime errors:', errors.length ? errors : 'none');

  await browser.close();
  server.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
