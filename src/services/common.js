/** An error meant for the user. `key` is an i18n key (see src/i18n), `params` fill its placeholders. */
class UserError extends Error {
  constructor(key, params = {}) {
    super(key);
    this.key = key;
    this.params = params;
  }
}

/** Both language variants of a catalog field, for use as an i18n param. */
const both = (obj, field = 'name') => ({ en: obj[field], id: obj[`${field}_id`] || obj[field] });

/** "b1234xyz" / "B-1234 xyz" -> "B 1234 XYZ" */
function normalizePlate(raw) {
  const compact = String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return compact.replace(/(?<=[A-Z])(?=\d)|(?<=\d)(?=[A-Z])/g, ' ');
}

/** "0812-3456 789" / "+62 812..." -> "6281234567 89" digits in international form (Indonesia default). */
function normalizePhone(raw) {
  let d = String(raw || '').replace(/\D/g, '');
  if (!d) return '';
  if (d.startsWith('0')) d = `62${d.slice(1)}`;
  else if (d.startsWith('8')) d = `62${d}`;
  return d;
}

function toInt(v, fallback = 0) {
  const n = Number.parseInt(String(v ?? '').replace(/[^\d-]/g, ''), 10);
  return Number.isFinite(n) ? n : fallback;
}

/** Trimmed string limited to `max` chars, or null when empty. */
const clean = (v, max = 200) => String(v ?? '').trim().slice(0, max) || null;

const PAYMENT_METHODS = ['Cash', 'QRIS', 'Bank Transfer', 'Debit Card', 'E-Wallet'];

module.exports = { UserError, both, normalizePlate, normalizePhone, toInt, clean, PAYMENT_METHODS };
