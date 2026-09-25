const crypto = require('node:crypto');
const { db, now, today, tx } = require('../db');
const { UserError, normalizePlate, toInt, clean, PAYMENT_METHODS } = require('./common');
const { packagePrice, activeAddons } = require('./catalog');
const { upsertVehicle } = require('./vehicles');
const work = require('./work');
const notifications = require('./notifications');

/** Price breakdown for a new transaction. */
function quote({ vehicleTypeId, packageId, addonIds = [], discount = 0 }) {
  const { type, pkg, price } = packagePrice(vehicleTypeId, packageId);
  const addons = activeAddons(addonIds);
  const addonsTotal = addons.reduce((sum, a) => sum + a.price, 0);
  const subtotal = price + addonsTotal;
  const disc = Math.min(Math.max(toInt(discount), 0), subtotal);
  return { type, pkg, packagePrice: price, addons, addonsTotal, subtotal, discount: disc, total: subtotal - disc };
}

function nextCode() {
  const d = today().replace(/-/g, '').slice(2);
  const prefix = `WSH-${d}-`;
  const last = db.prepare('SELECT code FROM transactions WHERE code LIKE ? ORDER BY id DESC LIMIT 1').get(`${prefix}%`);
  const seq = last ? toInt(last.code.slice(prefix.length)) + 1 : 1;
  return prefix + String(seq).padStart(3, '0');
}

function createTransaction(input, userId, { bookingId = null } = {}) {
  const plate = normalizePlate(input.plate);
  if (!plate || plate.length < 3) throw new UserError('err.plate');

  return tx(() => {
    const q = quote({
      vehicleTypeId: toInt(input.vehicle_type_id),
      packageId: toInt(input.package_id),
      addonIds: input.addon_ids,
      discount: input.discount,
    });
    const { vehicleId, customerId } = upsertVehicle({
      plate, vehicleTypeId: q.type.id, brandModel: input.brand_model, color: input.color,
      customerName: input.customer_name, customerPhone: input.customer_phone,
    });

    const paid = input.pay_now === 'on' || input.pay_now === '1';
    const method = paid ? (PAYMENT_METHODS.includes(input.payment_method) ? input.payment_method : 'Cash') : null;
    const ts = now();
    const txId = Number(db.prepare(`
      INSERT INTO transactions (code, vehicle_id, customer_id, vehicle_type_id, vehicle_type_name, vehicle_type_name_id, package_id,
        package_name, package_name_id, package_price, addons_total, discount, total, payment_status, payment_method, notes,
        created_by, created_at, paid_at, token, booking_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      nextCode(), vehicleId, customerId, q.type.id, q.type.name, q.type.name_id ?? null, q.pkg.id, q.pkg.name, q.pkg.name_id ?? null,
      q.packagePrice, q.addonsTotal, q.discount, q.total, paid ? 'paid' : 'unpaid', method,
      clean(input.notes, 300), userId, ts, paid ? ts : null, crypto.randomBytes(12).toString('base64url'), bookingId,
    ).lastInsertRowid);

    for (const a of q.addons) {
      db.prepare('INSERT INTO transaction_addons (transaction_id, addon_id, name, name_id, price) VALUES (?, ?, ?, ?, ?)')
        .run(txId, a.id, a.name, a.name_id ?? null, a.price);
    }
    notifications.notifyTransaction('tx_received', txId);
    return txId;
  });
}

const TX_SELECT = `
  SELECT x.*, v.plate, v.brand_model, v.color, c.name AS customer_name, c.phone AS customer_phone, u.name AS cashier_name,
    w.name AS washer_name, b.name AS bay_name
  FROM transactions x
  JOIN vehicles v ON v.id = x.vehicle_id
  LEFT JOIN customers c ON c.id = x.customer_id
  LEFT JOIN users u ON u.id = x.created_by
  LEFT JOIN users w ON w.id = x.washer_id
  LEFT JOIN bays b ON b.id = x.bay_id`;

function getTransaction(id) {
  const t = db.prepare(`${TX_SELECT} WHERE x.id = ?`).get(id);
  if (!t) return null;
  return { ...t, addons: db.prepare('SELECT * FROM transaction_addons WHERE transaction_id = ?').all(id), checks: work.getChecks(id) };
}

/** Public tracking page data, looked up by the transaction's private token. */
function getTransactionByToken(token) {
  if (!token || typeof token !== 'string' || token.length > 64) return null;
  const t = db.prepare(`${TX_SELECT} WHERE x.token = ?`).get(token);
  if (!t) return null;
  return { ...t, addons: db.prepare('SELECT * FROM transaction_addons WHERE transaction_id = ?').all(t.id), checks: work.getChecks(t.id) };
}

function listTransactions({ date, status, q } = {}) {
  const where = [];
  const params = [];
  if (date) { where.push('substr(x.created_at, 1, 10) = ?'); params.push(date); }
  if (status === 'unpaid') where.push("x.payment_status = 'unpaid' AND x.status != 'cancelled'");
  else if (status) { where.push('x.status = ?'); params.push(status); }
  if (q) {
    where.push('(v.plate LIKE ? OR x.code LIKE ? OR c.name LIKE ?)');
    const like = `%${q.trim()}%`;
    params.push(like, like, like);
  }
  const sql = `${TX_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY x.id DESC LIMIT 300`;
  return db.prepare(sql).all(...params);
}

function queue() {
  const rows = db.prepare(`${TX_SELECT}
    WHERE x.status IN ('waiting', 'washing') OR (x.status = 'done' AND substr(x.finished_at, 1, 10) = ?)
    ORDER BY x.id`).all(today());
  return {
    waiting: rows.filter((r) => r.status === 'waiting'),
    washing: rows.filter((r) => r.status === 'washing'),
    done: rows.filter((r) => r.status === 'done').reverse(),
  };
}

function cancelTransaction(id) {
  const t = db.prepare('SELECT * FROM transactions WHERE id = ?').get(id);
  if (!t) throw new UserError('err.txNotFound');
  if (!['waiting', 'washing'].includes(t.status)) throw new UserError('err.badTransition', { status: { key: `status.${t.status}` } });
  if (t.payment_status === 'paid') throw new UserError('err.paidCancel');
  db.prepare("UPDATE transactions SET status = 'cancelled' WHERE id = ?").run(id);
}

/** Move a transaction through the queue: start (optionally with washer + bay), finish, or cancel. */
function changeStatus(id, action, opts = {}) {
  if (action === 'start') return work.startWash(id, opts);
  if (action === 'finish') return work.finishWash(id);
  if (action === 'cancel') return cancelTransaction(id);
  throw new UserError('err.unknownAction');
}

function markPaid(id, method) {
  if (!PAYMENT_METHODS.includes(method)) throw new UserError('err.chooseMethod');
  const t = db.prepare('SELECT * FROM transactions WHERE id = ?').get(id);
  if (!t) throw new UserError('err.txNotFound');
  if (t.status === 'cancelled') throw new UserError('err.cancelled');
  if (t.payment_status === 'paid') throw new UserError('err.alreadyPaid');
  db.prepare("UPDATE transactions SET payment_status = 'paid', payment_method = ?, paid_at = ? WHERE id = ?").run(method, now(), id);
}

/** Public status lookup by plate — only exposes non-personal fields. */
function publicStatus(plate) {
  const p = normalizePlate(plate);
  if (!p) return null;
  return db.prepare(`
    SELECT x.code, x.status, x.package_name, x.package_name_id, x.created_at, x.started_at, x.finished_at
    FROM transactions x JOIN vehicles v ON v.id = x.vehicle_id
    WHERE v.plate = ? AND x.status != 'cancelled' AND substr(x.created_at, 1, 10) = ?
    ORDER BY x.id DESC`).all(p, today());
}

module.exports = {
  quote, createTransaction, getTransaction, getTransactionByToken, listTransactions, queue, changeStatus, markPaid, publicStatus, TX_SELECT,
};
