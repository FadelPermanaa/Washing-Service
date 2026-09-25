// WhatsApp messages to customers.
//
// Every message is written to the `notifications` outbox first:
// - With a gateway token (WHATSAPP_TOKEN, Fonnte-compatible API) messages are `pending` and sent in the background.
// - Without one they are `manual`: staff see a "Send via WhatsApp" button that opens WhatsApp with the text ready.
const { db, now } = require('../db');
const settings = require('../settings');
const { translator } = require('../i18n');

const GATEWAY_URL = process.env.WHATSAPP_API_URL || 'https://api.fonnte.com/send';
const gatewayToken = () => process.env.WHATSAPP_TOKEN || '';
const hasGateway = () => Boolean(gatewayToken());

let lastSeenBaseUrl = '';
/** Remember the address the site is reached at, for links in messages (PUBLIC_URL / settings win). */
function rememberBaseUrl(url) { lastSeenBaseUrl = url; }
function baseUrl() {
  return (process.env.PUBLIC_URL || settings.get('public_url') || lastSeenBaseUrl || '').replace(/\/$/, '');
}

// Links are stored as "{BASE}/t/…" and completed when the message is shown or sent,
// so messages queued before the site address is known still get a full link.
const BASE = '{BASE}';
const withBase = (text) => text.split(BASE).join(baseUrl());

function businessName() {
  return process.env.BUSINESS_NAME || 'Sparkle Wash';
}

function insert({ kind, transactionId = null, bookingId = null, phone, message }) {
  const status = hasGateway() ? 'pending' : 'manual';
  try {
    const r = db.prepare(`INSERT INTO notifications (kind, transaction_id, booking_id, phone, message, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(kind, transactionId, bookingId, phone, message, status, now());
    if (status === 'pending') setImmediate(() => processQueue().catch(() => {}));
    return Number(r.lastInsertRowid);
  } catch (err) {
    if (/UNIQUE/.test(err.message)) return null; // already queued once
    throw err;
  }
}

const L = (lang, row, field) => (lang === 'id' && row[`${field}_id`]) || row[field];

/** Queue a message about a transaction: 'tx_received' or 'tx_ready'. */
function notifyTransaction(kind, txId) {
  if (!settings.bool('whatsapp_enabled')) return null;
  const x = db.prepare(`SELECT x.*, v.plate, c.name AS customer_name, c.phone, b.lang AS booking_lang
    FROM transactions x JOIN vehicles v ON v.id = x.vehicle_id LEFT JOIN customers c ON c.id = x.customer_id
    LEFT JOIN bookings b ON b.id = x.booking_id WHERE x.id = ?`).get(txId);
  if (!x?.phone) return null;
  const phone = require('./common').normalizePhone(x.phone);
  if (phone.length < 10) return null;
  const lang = x.booking_lang || settings.get('message_lang') || 'id';
  const t = translator(lang);
  const message = t(`wa.${kind}`, {
    name: x.customer_name || t('wa.customer'), business: businessName(), plate: x.plate,
    package: L(lang, x, 'package_name'), total: `Rp ${x.total.toLocaleString('id-ID')}`,
    link: `${BASE}/t/${x.token}`,
  });
  return insert({ kind, transactionId: x.id, phone, message });
}

/** Queue a message about a booking: booking_confirmed / booking_pending / booking_cancelled / booking_reminder. */
function notifyBooking(kind, bookingId) {
  if (!settings.bool('whatsapp_enabled')) return null;
  const b = db.prepare(`SELECT b.*, p.name AS package_name, p.name_id AS package_name_id FROM bookings b
    JOIN packages p ON p.id = b.package_id WHERE b.id = ?`).get(bookingId);
  if (!b?.phone) return null;
  const t = translator(b.lang);
  const date = new Date(`${b.date}T00:00:00`).toLocaleDateString(t('locale'), { weekday: 'long', day: 'numeric', month: 'long' });
  const message = t(`wa.${kind}`, {
    name: b.customer_name, business: businessName(), plate: b.plate, package: L(b.lang, b, 'package_name'),
    date, time: b.start_time, code: b.code, link: `${BASE}/b/${b.token}`,
  });
  return insert({ kind, bookingId: b.id, phone: b.phone, message });
}

/** Queue reminders for confirmed bookings starting within the next 2 hours (each booking once). */
function queueReminders() {
  const d = new Date();
  const later = new Date(d.getTime() + 2 * 60 * 60 * 1000);
  const rows = db.prepare(`SELECT id FROM bookings WHERE status = 'confirmed'
    AND (date || ' ' || start_time) > ? AND (date || ' ' || start_time) <= ?`).all(now(d).slice(0, 16), now(later).slice(0, 16));
  rows.forEach((r) => notifyBooking('booking_reminder', r.id));
  return rows.length;
}

// ---------- Sending through the gateway ----------

let sending = false;

async function sendOne(n) {
  const res = await fetch(GATEWAY_URL, {
    method: 'POST',
    headers: { Authorization: gatewayToken(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ target: n.phone, message: withBase(n.message), countryCode: '62' }),
    signal: AbortSignal.timeout(15000),
  });
  let body = {};
  try { body = await res.json(); } catch { /* not JSON */ }
  if (!res.ok || body.status === false) throw new Error(body.reason || body.detail || `HTTP ${res.status}`);
}

async function processQueue() {
  if (!hasGateway() || sending) return 0;
  sending = true;
  let sent = 0;
  try {
    const rows = db.prepare("SELECT * FROM notifications WHERE status IN ('pending', 'failed') AND attempts < 3 ORDER BY id LIMIT 20").all();
    for (const n of rows) {
      try {
        await sendOne(n);
        db.prepare("UPDATE notifications SET status = 'sent', sent_at = ?, error = NULL, attempts = attempts + 1 WHERE id = ?").run(now(), n.id);
        sent++;
      } catch (err) {
        db.prepare("UPDATE notifications SET status = 'failed', error = ?, attempts = attempts + 1 WHERE id = ?").run(String(err.message).slice(0, 300), n.id);
      }
    }
  } finally {
    sending = false;
  }
  return sent;
}

// ---------- Staff views ----------

/** WhatsApp click-to-chat link with the message ready to send. */
function waLink(n) {
  return `https://wa.me/${n.phone}?text=${encodeURIComponent(withBase(n.message))}`;
}

const present = (n) => ({ ...n, message: withBase(n.message), wa: waLink(n) });

function outbox({ status } = {}) {
  const where = status === 'open' ? "WHERE n.status IN ('manual', 'failed', 'pending')" : '';
  return db.prepare(`SELECT n.*, x.code AS tx_code, bk.code AS booking_code, u.name AS handled_by_name
    FROM notifications n LEFT JOIN transactions x ON x.id = n.transaction_id LEFT JOIN bookings bk ON bk.id = n.booking_id
    LEFT JOIN users u ON u.id = n.handled_by ${where} ORDER BY n.id DESC LIMIT 200`).all().map(present);
}

function openCount() {
  return db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE status IN ('manual', 'failed')").get().n;
}

function forTransaction(txId) {
  return db.prepare('SELECT * FROM notifications WHERE transaction_id = ? ORDER BY id').all(txId).map(present);
}

function markHandled(id, userId) {
  db.prepare("UPDATE notifications SET status = 'done', sent_at = COALESCE(sent_at, ?), handled_by = ? WHERE id = ? AND status IN ('manual', 'failed', 'pending')")
    .run(now(), userId, id);
}

function retry(id) {
  db.prepare("UPDATE notifications SET status = 'pending', attempts = 0, error = NULL WHERE id = ? AND status = 'failed'").run(id);
  setImmediate(() => processQueue().catch(() => {}));
}

module.exports = {
  notifyTransaction, notifyBooking, queueReminders, processQueue, outbox, openCount, forTransaction, markHandled, retry,
  rememberBaseUrl, hasGateway, waLink,
};
