// Render stage.html to numbered JPEG frames.
//   node render.js h            -> frames/h/00000.jpg … (16:9, 1920x1080)
//   node render.js v            -> frames/v/…          (9:16, 1080x1920)
//   node render.js h 2,6.5,10   -> preview/h-2.jpg …   (single frames for checking)
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

let chromium;
try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require(path.join(execSync('npm root -g').toString().trim(), 'playwright'))); }

const FPS = 30;
const fmt = process.argv[2] === 'v' ? 'v' : 'h';
const only = process.argv[3] ? process.argv[3].split(',').map(Number) : null;
const size = fmt === 'v' ? { width: 1080, height: 1920 } : { width: 1920, height: 1080 };

(async () => {
  const browser = await chromium.launch({ args: ['--allow-file-access-from-files'] });
  const page = await browser.newPage({ viewport: size, deviceScaleFactor: 1 });
  const url = 'file://' + path.join(__dirname, 'stage.html') + '?render=1' + (fmt === 'v' ? '&f=v' : '');
  await page.goto(url);
  await page.evaluate(() => window.ready);
  const duration = await page.evaluate(() => window.DURATION);

  const outDir = path.join(__dirname, only ? 'preview' : `frames/${fmt}`);
  fs.mkdirSync(outDir, { recursive: true });
  const times = only || Array.from({ length: Math.round(duration * FPS) }, (_, i) => i / FPS);

  for (let i = 0; i < times.length; i++) {
    await page.evaluate((t) => window.seek(t), times[i]);
    const file = only ? `${fmt}-${times[i]}.jpg` : String(i).padStart(5, '0') + '.jpg';
    await page.screenshot({ path: path.join(outDir, file), type: 'jpeg', quality: 92 });
    if (!only && i % 150 === 0) console.log(`${fmt} ${i}/${times.length}`);
  }
  await browser.close();
  console.log('done', times.length, 'frames ->', outDir);
})().catch((e) => { console.error(e); process.exit(1); });
