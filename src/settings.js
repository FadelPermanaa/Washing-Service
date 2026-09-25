// Shop settings stored in the `settings` table, with defaults for anything not set yet.
const { db } = require('./db');

const DEFAULTS = {
  open_time: '08:00',
  close_time: '18:00',
  closed_days: '', // comma-separated weekday numbers, 0 = Sunday
  slot_minutes: '30',
  booking_enabled: '1',
  booking_auto_confirm: '1',
  booking_days_ahead: '14',
  booking_min_notice: '60', // minutes
  business_phone: '', // WhatsApp number shown to customers, e.g. 6281234567890
  business_address: '',
  whatsapp_enabled: '1',
  stamp_every: '10', // every Nth paid wash is free; 0 disables the stamp card
};

function all() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  return { ...DEFAULTS, ...Object.fromEntries(rows.map((r) => [r.key, r.value])) };
}

function get(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : DEFAULTS[key];
}

function set(values) {
  const stmt = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value');
  for (const [k, v] of Object.entries(values)) {
    if (k in DEFAULTS) stmt.run(k, String(v ?? ''));
  }
}

const int = (key) => Number.parseInt(get(key), 10) || 0;
const bool = (key) => get(key) === '1';

module.exports = { all, get, set, int, bool, DEFAULTS };
