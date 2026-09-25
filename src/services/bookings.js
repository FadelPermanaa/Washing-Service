// Online bookings: opening hours, time slots limited by the number of wash bays, and check-in to the queue.
const crypto = require('node:crypto');
const { db, now, today, tx } = require('../db');
const settings = require('../settings');
const { UserError, normalizePlate, normalizePhone, toInt, clean } = require('./common');
const { packagePrice, activeAddons } = require('./catalog');

const toMin = (hhmm) => {
  const [h, m] = String(hhmm).split(':').map(Number);
  return h * 60 + m;
};
const toTime = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
const token = () => crypto.randomBytes(12).toString('base64url');

function localDate(d) {
  return now(d).slice(0, 10);
}

/** Days customers can book, starting today. */
function bookableDays() {
  const closed = settings.get('closed_days').split(',').filter(Boolean).map(Number);
  const days = [];
  const d = new Date();
  for (let i = 0; i <= settings.int('booking_days_ahead'); i++) {
    if (!closed.includes(d.getDay())) days.push(localDate(d));
    d.setDate(d.getDate() + 1);
  }
  return days;
}

function capacity() {
  return Math.max(1, db.prepare('SELECT COUNT(*) AS n FROM bays WHERE active = 1').get().n);
}

/** Time slots for a date and package: [{ time, end, available }]. */
function slotsFor(date, packageId) {
  const pkg = db.prepare('SELECT * FROM packages WHERE id = ? AND active = 1').get(toInt(packageId));
  if (!pkg || !bookableDays().includes(date)) return [];
  const step = Math.max(10, settings.int('slot_minutes'));
  const open = toMin(settings.get('open_time'));
  const close = toMin(settings.get('close_time'));
  const duration = Math.max(10, pkg.duration_min || step);
  const cap = capacity();
  const existing = db.prepare("SELECT start_time, end_time FROM bookings WHERE date = ? AND status IN ('pending', 'confirmed')").all(date)
    .map((b) => [toMin(b.start_time), toMin(b.end_time)]);
  const nowD = new Date();
  const earliest = date === today() ? nowD.getHours() * 60 + nowD.getMinutes() + settings.int('booking_min_notice') : -1;

  const slots = [];
  for (let s = open; s + duration <= close; s += step) {
    let ok = s >= earliest;
    // Every step-sized piece of the booking must have a free bay.
    for (let t = s; ok && t < s + duration; t += step) {
      const end = Math.min(t + step, s + duration);
      const overlapping = existing.filter(([a, b]) => a < end && b > t).length;
      if (overlapping >= cap) ok = false;
    }
    slots.push({ time: toTime(s), end: toTime(s + duration), available: ok });
  }
  return slots;
}

function nextCode(date) {
  const prefix = `BKG-${date.replace(/-/g, '').slice(2)}-`;
  const last = db.prepare('SELECT code FROM bookings WHERE code LIKE ? ORDER BY id DESC LIMIT 1').get(`${prefix}%`);
  const seq = last ? toInt(last.code.slice(prefix.length)) + 1 : 1;
  return prefix + String(seq).padStart(3, '0');
}

function createBooking(input, { lang = 'id', source = 'online' } = {}) {
  if (!settings.bool('booking_enabled')) throw new UserError('err.bookingClosed');
  const name = clean(input.customer_name, 80);
  if (!name) throw new UserError('err.nameRequired');
  const phone = normalizePhone(input.phone);
  if (phone.length < 10 || phone.length > 15) throw new UserError('err.phone');
  const plate = normalizePlate(input.plate);
  if (!plate || plate.length < 3) throw new UserError('err.plate');
  const date = String(input.date || '');
  const time = String(input.time || '');

  return tx(() => {
    const { type, pkg, price } = packagePrice(toInt(input.vehicle_type_id), toInt(input.package_id));
    const addons = activeAddons(input.addon_ids);
    const slot = slotsFor(date, pkg.id).find((s) => s.time === time);
    if (!slot) throw new UserError('err.chooseSlot');
    if (!slot.available) throw new UserError('err.slotTaken');
    const status = settings.bool('booking_auto_confirm') ? 'confirmed' : 'pending';
    const ts = now();
    const id = Number(db.prepare(`INSERT INTO bookings (code, token, customer_name, phone, plate, vehicle_type_id, package_id, addon_ids,
        date, start_time, end_time, price_estimate, status, notes, lang, source, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      nextCode(date), token(), name, phone, plate, type.id, pkg.id, JSON.stringify(addons.map((a) => a.id)),
      date, slot.time, slot.end, price + addons.reduce((s, a) => s + a.price, 0), status, clean(input.notes, 300),
      lang === 'en' ? 'en' : 'id', source, ts, ts,
    ).lastInsertRowid);
    return getBooking(id);
  });
}

const BOOKING_SELECT = `
  SELECT b.*, p.name AS package_name, p.name_id AS package_name_id, p.duration_min,
    v.name AS vehicle_type_name, v.name_id AS vehicle_type_name_id, x.code AS tx_code, x.token AS tx_token, x.status AS tx_status
  FROM bookings b
  JOIN packages p ON p.id = b.package_id
  JOIN vehicle_types v ON v.id = b.vehicle_type_id
  LEFT JOIN transactions x ON x.id = b.transaction_id`;

function withAddons(b) {
  if (!b) return null;
  const ids = JSON.parse(b.addon_ids || '[]');
  const addons = ids.length ? db.prepare(`SELECT * FROM addons WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids) : [];
  return { ...b, addons };
}

function getBooking(id) {
  return withAddons(db.prepare(`${BOOKING_SELECT} WHERE b.id = ?`).get(id));
}

function getBookingByToken(t) {
  if (!t || typeof t !== 'string' || t.length > 64) return null;
  return withAddons(db.prepare(`${BOOKING_SELECT} WHERE b.token = ?`).get(t));
}

function listBookings(date) {
  return db.prepare(`${BOOKING_SELECT} WHERE b.date = ? ORDER BY b.start_time, b.id`).all(date);
}

/** Pending and confirmed bookings for today that have not arrived yet. */
function upcomingToday() {
  return db.prepare(`${BOOKING_SELECT} WHERE b.date = ? AND b.status IN ('pending', 'confirmed') ORDER BY b.start_time`).all(today());
}

/** Can the customer still cancel online? Until the booked time starts. */
function customerCanCancel(b) {
  if (!['pending', 'confirmed'].includes(b.status)) return false;
  return `${b.date} ${b.start_time}:00` > now();
}

function cancelByCustomer(t) {
  const b = getBookingByToken(t);
  if (!b) throw new UserError('err.bookingNotFound');
  if (!customerCanCancel(b)) throw new UserError('err.bookingCannotCancel');
  db.prepare("UPDATE bookings SET status = 'cancelled', updated_at = ? WHERE id = ?").run(now(), b.id);
  return b;
}

const STAFF_ACTIONS = {
  confirm: { from: ['pending'], to: 'confirmed' },
  no_show: { from: ['pending', 'confirmed'], to: 'no_show' },
  cancel: { from: ['pending', 'confirmed'], to: 'cancelled' },
};

function staffUpdate(id, actionName) {
  const rule = STAFF_ACTIONS[actionName];
  if (!rule) throw new UserError('err.unknownAction');
  const b = getBooking(id);
  if (!b) throw new UserError('err.bookingNotFound');
  if (!rule.from.includes(b.status)) throw new UserError('err.bookingStatus', { status: { key: `booking.status.${b.status}` } });
  db.prepare('UPDATE bookings SET status = ?, updated_at = ? WHERE id = ?').run(rule.to, now(), id);
  return getBooking(id);
}

/** Customer arrived: turn the booking into a transaction in the queue. */
function checkIn(id, userId) {
  const { createTransaction } = require('./transactions');
  return tx(() => {
    const b = getBooking(id);
    if (!b) throw new UserError('err.bookingNotFound');
    if (!['pending', 'confirmed'].includes(b.status)) throw new UserError('err.bookingStatus', { status: { key: `booking.status.${b.status}` } });
    const txId = createTransaction({
      plate: b.plate, vehicle_type_id: b.vehicle_type_id, package_id: b.package_id, addon_ids: JSON.parse(b.addon_ids),
      customer_name: b.customer_name, customer_phone: b.phone, notes: b.notes,
    }, userId, { bookingId: b.id });
    db.prepare("UPDATE bookings SET status = 'checked_in', transaction_id = ?, updated_at = ? WHERE id = ?").run(txId, now(), b.id);
    return txId;
  });
}

module.exports = {
  bookableDays, slotsFor, createBooking, getBooking, getBookingByToken, listBookings, upcomingToday,
  customerCanCancel, cancelByCustomer, staffUpdate, checkIn,
};
