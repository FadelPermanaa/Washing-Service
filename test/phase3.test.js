// WhatsApp messages without a gateway: they wait in the outbox for staff to send with one tap.
const test = require('node:test');
const assert = require('node:assert/strict');
const { bootApp, Client } = require('./helpers');

let env;
let admin;
let svc;
test.before(async () => {
  delete process.env.WHATSAPP_TOKEN;
  env = await bootApp();
  svc = require('../src/services');
  admin = new Client(env.base);
  await admin.login();
});
test.after(async () => { await env.close(); });

const lastNotif = () => env.db.prepare('SELECT * FROM notifications ORDER BY id DESC LIMIT 1').get();

test('a walk-in with a phone number gets a "received" message with the tracking link', async () => {
  await admin.get('/app/transactions/new');
  await admin.post('/app/transactions', { plate: 'B 5 WA', vehicle_type_id: 2, package_id: 2, customer_name: 'Andi', customer_phone: '0812 1111 2222' });
  const tx = env.db.prepare('SELECT * FROM transactions ORDER BY id DESC LIMIT 1').get();
  const n = lastNotif();
  assert.equal(n.kind, 'tx_received');
  assert.equal(n.status, 'manual');
  assert.equal(n.phone, '6281211112222');
  assert.match(n.message, /^Halo Andi, kendaraan B 5 WA sudah kami terima/);
  assert.match(n.message, /Cuci Luar Dalam/);
  assert.ok(n.message.includes(`{BASE}/t/${tx.token}`));
  const shown = svc.notifications.outbox()[0];
  assert.match(shown.message, new RegExp(`http://127.0.0.1:\\d+/t/${tx.token}`));
});

test('no phone number, no message', async () => {
  const before = env.db.prepare('SELECT COUNT(*) AS n FROM notifications').get().n;
  await admin.get('/app/transactions/new');
  await admin.post('/app/transactions', { plate: 'B 6 NO', vehicle_type_id: 2, package_id: 1 });
  assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM notifications').get().n, before);
});

test('finishing the wash queues a "ready" message, only once', async () => {
  const tx = env.db.prepare("SELECT t.id FROM transactions t JOIN vehicles v ON v.id = t.vehicle_id WHERE v.plate = 'B 5 WA'").get();
  await admin.get('/app/queue');
  await admin.post(`/app/transactions/${tx.id}/status`, { action: 'start' });
  await admin.post(`/app/transactions/${tx.id}/status`, { action: 'finish' });
  const n = lastNotif();
  assert.equal(n.kind, 'tx_ready');
  assert.match(n.message, /siap diambil/);
  assert.equal(svc.notifications.notifyTransaction('tx_ready', tx.id), null, 'duplicate is ignored');
});

test('booking messages use the language the customer booked in', async () => {
  const c = new Client(env.base);
  await c.get('/booking?lang=en');
  await c.post('/booking', {
    vehicle_type_id: 2, package_id: 1, date: svc.bookableDays()[1], time: '09:00', customer_name: 'Jane', phone: '081299998888', plate: 'B 9 EN',
  });
  const n = lastNotif();
  assert.equal(n.kind, 'booking_confirmed');
  assert.match(n.message, /^Hi Jane, your booking at .* is confirmed/);
  assert.match(n.message, /Exterior Wash · B 9 EN/);
});

test('staff see open messages and can mark them sent', async () => {
  const page = await admin.get('/app/whatsapp?lang=en');
  assert.equal(page.status, 200);
  assert.match(page.text, /Send via WhatsApp/);
  assert.match(page.text, /https:\/\/wa\.me\/6281211112222\?text=Halo%20Andi/);
  assert.match(page.text, /class="nav-count">3</);
  const n = lastNotif();
  const r = await admin.request('POST', `/app/whatsapp/${n.id}`, { headers: { accept: 'application/json', 'x-csrf-token': admin.csrf } });
  assert.equal(r.status, 200);
  const after = env.db.prepare('SELECT status, handled_by FROM notifications WHERE id = ?').get(n.id);
  assert.equal(after.status, 'done');
  assert.ok(after.handled_by);
  // without the CSRF header it is refused
  const other = env.db.prepare("SELECT id FROM notifications WHERE status = 'manual' LIMIT 1").get();
  const bad = await admin.request('POST', `/app/whatsapp/${other.id}`, { headers: { accept: 'application/json' } });
  assert.equal(bad.status, 403);
});

test('reminders are queued once for bookings starting within 2 hours', () => {
  const { now } = require('../src/db');
  const soon = new Date(Date.now() + 90 * 60 * 1000);
  const stamp = now(soon);
  env.db.prepare(`INSERT INTO bookings (code, token, customer_name, phone, plate, vehicle_type_id, package_id, date, start_time, end_time, status, lang, created_at, updated_at)
    VALUES ('BKG-TEST-1', 'reminder-token-0001', 'Rudi', '6281233334444', 'B 1 RM', 2, 1, ?, ?, ?, 'confirmed', 'id', ?, ?)`)
    .run(stamp.slice(0, 10), stamp.slice(11, 16), stamp.slice(11, 16), stamp, stamp);
  assert.ok(svc.notifications.queueReminders() >= 1);
  svc.notifications.queueReminders();
  const rows = env.db.prepare("SELECT * FROM notifications WHERE kind = 'booking_reminder'").all();
  assert.equal(rows.length, 1);
  assert.match(rows[0].message, /sekadar mengingatkan/);
});

test('messages can be switched off', async () => {
  await admin.get('/app/settings');
  await admin.post('/app/settings/business', { business_phone: '', message_lang: 'id' }); // whatsapp_enabled unchecked
  const before = env.db.prepare('SELECT COUNT(*) AS n FROM notifications').get().n;
  await admin.get('/app/transactions/new');
  await admin.post('/app/transactions', { plate: 'B 7 OFF', vehicle_type_id: 2, package_id: 1, customer_name: 'X', customer_phone: '081200000000' });
  assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM notifications').get().n, before);
});
