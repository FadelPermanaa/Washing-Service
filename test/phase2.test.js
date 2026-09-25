const test = require('node:test');
const assert = require('node:assert/strict');
const { bootApp, Client, flashText } = require('./helpers');

let env;
let svc;
let day;
test.before(async () => {
  env = await bootApp();
  svc = require('../src/services');
  day = svc.bookableDays()[1]; // tomorrow: no "minimum notice" surprises
});
test.after(async () => { await env.close(); });

async function book(c, overrides = {}) {
  await c.get('/booking');
  return c.post('/booking', {
    vehicle_type_id: 2, package_id: 1, date: day, time: '10:00',
    customer_name: 'Siti', phone: '0812-3456-7890', plate: 'b 777 ok', ...overrides,
  });
}

test('booking page renders in both languages', async () => {
  const c = new Client(env.base);
  assert.match((await c.get('/booking?lang=id')).text, /Booking cuci/);
  assert.match((await c.get('/booking?lang=en')).text, /Book a wash/);
});

test('slots follow opening hours and package duration', () => {
  const slots = svc.slotsFor(day, 1); // Exterior Wash, 20 min, 08:00–18:00, 30 min steps
  assert.equal(slots[0].time, '08:00');
  assert.equal(slots.at(-1).time, '17:30');
  const detailing = svc.slotsFor(day, 4); // 180 min must end by 18:00
  assert.equal(detailing.at(-1).time, '15:00');
  assert.equal(detailing.at(-1).end, '18:00');
});

test('a customer books online and gets a private page', async () => {
  const c = new Client(env.base);
  const r = await book(c);
  assert.equal(r.status, 302);
  assert.match(r.location, /^\/b\/[\w-]{16}\?new=1$/);
  const b = env.db.prepare('SELECT * FROM bookings ORDER BY id DESC LIMIT 1').get();
  assert.equal(b.status, 'confirmed');
  assert.equal(b.phone, '6281234567890');
  assert.equal(b.plate, 'B 777 OK');
  assert.equal(b.end_time, '10:20');
  assert.equal(b.price_estimate, 35000);
  const page = await c.get(r.location);
  assert.equal(page.status, 200);
  assert.match(page.text, new RegExp(b.code));
});

test('bookings are limited by the number of active bays', async () => {
  // Bay count is 2 and one booking already exists at 10:00.
  const c = new Client(env.base);
  assert.equal((await book(c, { plate: 'B 2 X' })).status, 302);
  const third = await book(c, { plate: 'B 3 X' });
  assert.equal(third.status, 422);
  assert.match(third.text, /baru saja terisi|just taken/);
  assert.equal(svc.slotsFor(day, 1).find((s) => s.time === '10:00').available, false);
  // A 3-hour detailing starting 08:00 overlaps 10:00, which is full.
  assert.equal(svc.slotsFor(day, 4).find((s) => s.time === '08:00').available, false);
  assert.equal(svc.slotsFor(day, 4).find((s) => s.time === '10:30').available, true);
});

test('invalid phone and missing CSRF are rejected', async () => {
  const c = new Client(env.base);
  const r = await book(c, { phone: '123', time: '11:00' });
  assert.equal(r.status, 422);
  const noToken = await c.request('POST', '/booking', { form: { _csrf: 'x', date: day, time: '11:00' } });
  assert.equal(noToken.status, 403);
});

test('customer can cancel, and the slot frees up', async () => {
  const c = new Client(env.base);
  const r = await book(c, { time: '12:00', plate: 'B 12 C' });
  const token = r.location.split('/')[2].split('?')[0];
  await c.get(`/b/${token}`);
  await c.post(`/b/${token}/cancel`);
  assert.equal(env.db.prepare('SELECT status FROM bookings WHERE token = ?').get(token).status, 'cancelled');
  const again = await c.postAndFollow(`/b/${token}/cancel`);
  assert.equal(flashText(again.text).type, 'error');
});

test('staff checks a booking in: it becomes a transaction with a tracking link', async () => {
  const admin = new Client(env.base);
  await admin.login();
  const b = env.db.prepare("SELECT * FROM bookings WHERE status = 'confirmed' ORDER BY id LIMIT 1").get();
  await admin.get(`/app/bookings?date=${day}`);
  const r = await admin.post(`/app/bookings/${b.id}`, { op: 'check_in' });
  assert.equal(r.status, 302);
  const after = env.db.prepare('SELECT * FROM bookings WHERE id = ?').get(b.id);
  assert.equal(after.status, 'checked_in');
  const tx = env.db.prepare('SELECT * FROM transactions WHERE id = ?').get(after.transaction_id);
  assert.equal(tx.booking_id, b.id);
  assert.ok(tx.token && tx.token.length >= 16);

  const pub = new Client(env.base);
  const track = await pub.get(`/t/${tx.token}`);
  assert.equal(track.status, 200);
  assert.match(track.text, /B 777 OK/);
  assert.doesNotMatch(track.text, /Siti|6281234567890/, 'tracking page must not show personal data');
  assert.equal((await pub.get('/t/not-a-real-token')).status, 404);

  // checking in twice is refused
  const twice = await admin.postAndFollow(`/app/bookings/${b.id}`, { op: 'check_in' });
  assert.equal(flashText(twice.text).type, 'error');
});

test('with auto-confirm off, bookings wait for staff', async () => {
  const admin = new Client(env.base);
  await admin.login();
  await admin.get('/app/settings');
  await admin.post('/app/settings/booking', {
    open_time: '08:00', close_time: '18:00', slot_minutes: 30, booking_days_ahead: 14, booking_min_notice: 60, booking_enabled: '1',
  });
  const c = new Client(env.base);
  await book(c, { time: '14:00', plate: 'B 14 P' });
  const b = env.db.prepare('SELECT * FROM bookings ORDER BY id DESC LIMIT 1').get();
  assert.equal(b.status, 'pending');
  await admin.get('/app/bookings');
  await admin.post(`/app/bookings/${b.id}`, { op: 'confirm' });
  assert.equal(env.db.prepare('SELECT status FROM bookings WHERE id = ?').get(b.id).status, 'confirmed');
});

test('closed days and disabled booking', async () => {
  const admin = new Client(env.base);
  await admin.login();
  await admin.get('/app/settings?lang=en');
  const weekday = new Date(`${day}T00:00:00`).getDay();
  await admin.post('/app/settings/booking', {
    open_time: '08:00', close_time: '18:00', slot_minutes: 30, booking_days_ahead: 14, booking_min_notice: 60,
    booking_enabled: '1', booking_auto_confirm: '1', closed_days: [weekday],
  });
  assert.ok(!svc.bookableDays().includes(day));
  const bad = await admin.postAndFollow('/app/settings/booking', { open_time: '18:00', close_time: '08:00' });
  assert.match(flashText(bad.text).text, /earlier than closing/);
  await admin.post('/app/settings/booking', { open_time: '08:00', close_time: '18:00', booking_auto_confirm: '1' });
  const c = new Client(env.base);
  assert.match((await c.get('/booking?lang=en')).text, /Online booking is closed/);
});
