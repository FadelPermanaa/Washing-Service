// Takes the app screenshots used in the video (shots/*.png) from a running demo server.
//
//   cd ../..  &&  npm run seed  &&  npm start      # demo data, server on :3000
//   node capture.js                                 # here, in another terminal
//
// Env: BASE_URL (default http://localhost:3000)
//      DATA_DIR (default ../../data) — the same data folder the server uses.
// It changes the demo data (ticks one wash's checklist step by step), so only
// point it at demo data, never at a real shop.
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

let chromium;
try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require(path.join(execSync('npm root -g').toString().trim(), 'playwright'))); }

const B = process.env.BASE_URL || 'http://localhost:3000';
const DATA_DIR = path.resolve(__dirname, process.env.DATA_DIR || '../../data');
const db = new DatabaseSync(process.env.DB_PATH || path.join(DATA_DIR, 'washing.db'));
const shot = (name) => path.join(__dirname, 'shots', name + '.png');

// Serve Poppins from fonts/ so screenshots never fall back to a system font.
const fontCss = fs.readFileSync(path.join(__dirname, 'fonts/fonts.css'), 'utf8').replace(/url\(([^)]+)\)/g, 'url(https://fonts.gstatic.com/local/$1)');
async function localFonts(ctx) {
  await ctx.route('https://fonts.googleapis.com/**', (r) => r.fulfill({ contentType: 'text/css', body: fontCss }));
  await ctx.route('https://fonts.gstatic.com/local/**', (r) => r.fulfill({ contentType: 'font/woff2', body: fs.readFileSync(path.join(__dirname, 'fonts', path.basename(new URL(r.request().url()).pathname))) }));
}
const settle = async (p) => { await p.evaluate(() => document.fonts.ready); await p.waitForTimeout(400); };
async function login(p, user, pass) {
  await p.goto(B + '/login?lang=id');
  await p.fill('#username', user);
  await p.fill('#password', pass);
  await Promise.all([p.waitForNavigation(), p.click('button[type=submit]')]);
}
const addMinutes = (ts, min) => {
  const d = new Date(ts.replace(' ', 'T'));
  d.setMinutes(d.getMinutes() + min);
  const z = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())} ${z(d.getHours())}:${z(d.getMinutes())}:00`;
};

(async () => {
  // A wash in progress with a washer and a checklist; start it at "3 steps done".
  const job = db.prepare(`SELECT t.id, t.token, t.started_at, t.washer_id, u.username FROM transactions t JOIN users u ON u.id = t.washer_id
    WHERE t.status = 'washing' AND (SELECT COUNT(*) FROM transaction_checks c WHERE c.transaction_id = t.id) >= 4 ORDER BY t.id LIMIT 1`).get();
  if (!job) throw new Error('No wash in progress with a checklist. Run `npm run seed` on fresh demo data first.');
  const checks = db.prepare('SELECT id FROM transaction_checks WHERE transaction_id = ? ORDER BY sort_order, id').all(job.id);
  checks.forEach((c, i) => db.prepare('UPDATE transaction_checks SET done_at = ?, done_by = ? WHERE id = ?')
    .run(i < 3 ? job.started_at : null, i < 3 ? job.washer_id : null, c.id));
  const member = db.prepare("SELECT v.plate FROM memberships m JOIN vehicles v ON v.id = m.vehicle_id WHERE m.status = 'active' ORDER BY m.id LIMIT 1").get();

  const browser = await chromium.launch();

  // Laptop screens (1440x900 @2x)
  const lapCtx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  await localFonts(lapCtx);
  const lap = await lapCtx.newPage();
  await login(lap, 'admin', 'admin123');
  await lap.goto(B + '/app/queue?lang=id', { waitUntil: 'networkidle' });
  await settle(lap);
  await lap.screenshot({ path: shot('queue') });
  await lap.goto(B + '/app/transactions/new?lang=id' + (member ? '&plate=' + encodeURIComponent(member.plate) : ''), { waitUntil: 'networkidle' });
  await lap.waitForTimeout(1200);
  await lap.check('input[name=package_id][value="2"]', { force: true });
  await lap.waitForTimeout(900);
  await lap.screenshot({ path: shot('newwash') });

  // Last month's report (a full month of data), taller so the video can zoom into it.
  const repCtx = await browser.newContext({ viewport: { width: 1440, height: 1500 }, deviceScaleFactor: 2 });
  await localFonts(repCtx);
  const rep = await repCtx.newPage();
  await login(rep, 'admin', 'admin123');
  const now = new Date();
  const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  await rep.goto(`${B}/app/reports?lang=id&month=${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, '0')}`, { waitUntil: 'networkidle' });
  await settle(rep);
  await rep.mouse.move(1439, 1499); // no chart tooltip
  await rep.screenshot({ path: shot('reports') });

  // Phone screens (390x844 @3x)
  const ph = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
  await localFonts(ph);

  // Booking: the time slots before and after picking the 6th one (10:30 with default hours).
  const pub = await ph.newPage();
  const tomorrow = new Date(Date.now() + 36 * 3600 * 1000).toISOString().slice(0, 10);
  await pub.goto(`${B}/booking?lang=id&vehicle_type_id=2&package_id=2&date=${tomorrow}`, { waitUntil: 'networkidle' });
  await settle(pub);
  await pub.evaluate(() => document.querySelector('#slots').scrollIntoView({ block: 'center' }));
  await pub.waitForTimeout(300);
  await pub.screenshot({ path: shot('booking-slots0') });
  await pub.click('.slot >> nth=5');
  await pub.waitForTimeout(300);
  await pub.screenshot({ path: shot('booking-slots') });

  // The washer ticks the next steps; the customer's tracking page follows along.
  const washer = await ph.newPage();
  await login(washer, job.username, 'washer123');
  const track = await ph.newPage();
  for (let step = 0; step <= 3; step++) {
    if (step < 3) {
      await track.goto(`${B}/t/${job.token}?lang=id`, { waitUntil: 'networkidle' });
      await settle(track);
      await track.screenshot({ path: shot(`track-${step}`) });
    }
    await washer.goto(`${B}/app/jobs/${job.id}?lang=id`, { waitUntil: 'networkidle' });
    await settle(washer);
    // Extra bottom padding keeps the scroll position identical in every state.
    await washer.evaluate(() => { document.body.style.paddingBottom = '900px'; document.querySelector('.checklist').scrollIntoView({ block: 'start' }); window.scrollBy(0, -74); });
    await washer.waitForTimeout(300);
    await washer.screenshot({ path: shot(`checklist-${step}`) });
    const next = checks[3 + step];
    if (!next) break;
    db.prepare('UPDATE transaction_checks SET done_at = ?, done_by = ? WHERE id = ?').run(addMinutes(job.started_at, [6, 11, 15][step]), job.washer_id, next.id);
  }

  await browser.close();
  console.log('Screenshots saved in shots/');
})().catch((e) => { console.error(e.message); process.exit(1); });
