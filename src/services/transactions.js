const crypto = require('node:crypto');
const { db, now, today, tx } = require('../db');
const { UserError, normalizePlate, toInt, clean, PAYMENT_METHODS } = require('./common');
const { packagePrice, activeAddons } = require('./catalog');
const { upsertVehicle } = require('./vehicles');
const work = require('./work');
const notifications = require('./notifications');
const payments = require('./payments');
const marketing = require('./marketing');

/**
 * Price breakdown for a new transaction.
 * Order: package + add-ons → free wash (stamp card) or membership covers the package → promo code → manual discount.
 * With `soft`, a bad promo code is reported in `promoError` instead of throwing (for the live preview).
 */
function quote({ vehicleTypeId, packageId, addonIds = [], discount = 0, promoCode = '', useStamp = false, useMembership = false, plate = '' }, { soft = false } = {}) {
  const { type, pkg, price } = packagePrice(vehicleTypeId, packageId);
  const addons = activeAddons(addonIds);
  const addonsTotal = addons.reduce((sum, a) => sum + a.price, 0);
  const subtotal = price + addonsTotal;

  const p = normalizePlate(plate);
  const vehicle = p ? db.prepare('SELECT * FROM vehicles WHERE plate = ?').get(p) : null;
  const stamps = marketing.stampStatus(vehicle);
  const membership = vehicle ? marketing.coveringMembership(vehicle.id, pkg.id, type.id) : null;

  const membershipDiscount = useMembership && membership ? price : 0;
  const freeDiscount = !membershipDiscount && useStamp && stamps.available ? price : 0;
  let remaining = subtotal - membershipDiscount - freeDiscount;

  let promo = null;
  let promoDiscount = 0;
  let promoError = null;
  try {
    ({ promo, discount: promoDiscount } = marketing.applyPromo(promoCode, remaining));
  } catch (err) {
    if (!soft || !(err instanceof UserError)) throw err;
    promoError = err;
  }
  remaining -= promoDiscount;
  const disc = Math.min(Math.max(toInt(discount), 0), remaining);
  const total = remaining - disc;

  return {
    type, pkg, packagePrice: price, addons, addonsTotal, subtotal,
    vehicle, membership, membershipDiscount, stamps, freeDiscount, stampsUsed: freeDiscount ? stamps.every : 0,
    promo, promoDiscount, promoError, discount: disc, total,
    earnsStamp: stamps.every > 0 && !freeDiscount && !membershipDiscount,
  };
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
      promoCode: input.promo_code,
      useStamp: input.use_stamp === '1' || input.use_stamp === 'on',
      useMembership: input.use_membership === '1' || input.use_membership === 'on',
      plate,
    });
    const { vehicleId, customerId } = upsertVehicle({
      plate, vehicleTypeId: q.type.id, brandModel: input.brand_model, color: input.color,
      customerName: input.customer_name, customerPhone: input.customer_phone,
    });

    // Nothing to pay (free wash / membership): it counts as paid straight away.
    const paid = q.total === 0 || input.pay_now === 'on' || input.pay_now === '1';
    const method = paid && q.total > 0 ? (PAYMENT_METHODS.includes(input.payment_method) ? input.payment_method : 'Cash') : null;
    const ts = now();
    const txId = Number(db.prepare(`
      INSERT INTO transactions (code, vehicle_id, customer_id, vehicle_type_id, vehicle_type_name, vehicle_type_name_id, package_id,
        package_name, package_name_id, package_price, addons_total, discount, total, payment_status, payment_method, notes,
        created_by, created_at, paid_at, token, booking_id,
        promo_id, promo_code, promo_discount, free_discount, stamps_used, membership_id, membership_discount, stamp_earned)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      nextCode(), vehicleId, customerId, q.type.id, q.type.name, q.type.name_id ?? null, q.pkg.id, q.pkg.name, q.pkg.name_id ?? null,
      q.packagePrice, q.addonsTotal, q.discount, q.total, paid ? 'paid' : 'unpaid', method,
      clean(input.notes, 300), userId, ts, paid ? ts : null, crypto.randomBytes(12).toString('base64url'), bookingId,
      q.promo?.id ?? null, q.promo?.code ?? null, q.promoDiscount, q.freeDiscount, q.stampsUsed,
      q.membershipDiscount ? q.membership.id : null, q.membershipDiscount, q.earnsStamp ? 1 : 0,
    ).lastInsertRowid);

    const stampChange = (q.earnsStamp ? 1 : 0) - q.stampsUsed;
    if (stampChange) db.prepare('UPDATE vehicles SET stamps = MAX(0, stamps + ?) WHERE id = ?').run(stampChange, vehicleId);
    if (q.membershipDiscount) {
      const used = db.prepare('UPDATE memberships SET washes_left = washes_left - 1 WHERE id = ? AND washes_left > 0').run(q.membership.id);
      if (!used.changes) throw new UserError('err.membershipEmpty');
    }

    for (const a of q.addons) {
      db.prepare('INSERT INTO transaction_addons (transaction_id, addon_id, name, name_id, price) VALUES (?, ?, ?, ?, ?)')
        .run(txId, a.id, a.name, a.name_id ?? null, a.price);
    }
    if (paid && q.total > 0) {
      db.prepare('INSERT INTO payments (transaction_id, amount, method, created_at, created_by) VALUES (?, ?, ?, ?, ?)')
        .run(txId, q.total, method, ts, userId ?? null);
    }
    notifications.notifyTransaction('tx_received', txId);
    return txId;
  });
}

const TX_SELECT = `
  SELECT x.*, v.plate, v.brand_model, v.color, c.name AS customer_name, c.phone AS customer_phone, u.name AS cashier_name,
    w.name AS washer_name, b.name AS bay_name,
    (SELECT COALESCE(SUM(p.amount), 0) FROM payments p WHERE p.transaction_id = x.id) AS paid_amount
  FROM transactions x
  JOIN vehicles v ON v.id = x.vehicle_id
  LEFT JOIN customers c ON c.id = x.customer_id
  LEFT JOIN users u ON u.id = x.created_by
  LEFT JOIN users w ON w.id = x.washer_id
  LEFT JOIN bays b ON b.id = x.bay_id`;

function getTransaction(id) {
  const t = db.prepare(`${TX_SELECT} WHERE x.id = ?`).get(id);
  if (!t) return null;
  const pays = payments.listPayments(id);
  const paid = pays.reduce((sum, p) => sum + p.amount, 0);
  return {
    ...t, addons: db.prepare('SELECT * FROM transaction_addons WHERE transaction_id = ?').all(id), checks: work.getChecks(id),
    payments: pays, paid, due: Math.max(0, t.total - paid),
  };
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
  return tx(() => {
    const t = db.prepare('SELECT * FROM transactions WHERE id = ?').get(id);
    if (!t) throw new UserError('err.txNotFound');
    if (!['waiting', 'washing'].includes(t.status)) throw new UserError('err.badTransition', { status: { key: `status.${t.status}` } });
    if (payments.paidAmount(id) > 0) throw new UserError('err.paidCancel');
    db.prepare("UPDATE transactions SET status = 'cancelled' WHERE id = ?").run(id);
    // Give back what this wash used up or earned.
    const stampChange = t.stamps_used - t.stamp_earned;
    if (stampChange) db.prepare('UPDATE vehicles SET stamps = MAX(0, stamps + ?) WHERE id = ?').run(stampChange, t.vehicle_id);
    if (t.membership_id) db.prepare('UPDATE memberships SET washes_left = washes_left + 1 WHERE id = ?').run(t.membership_id);
  });
}

/** Move a transaction through the queue: start (optionally with washer + bay), finish, or cancel. */
function changeStatus(id, action, opts = {}) {
  if (action === 'start') return work.startWash(id, opts);
  if (action === 'finish') return work.finishWash(id);
  if (action === 'cancel') return cancelTransaction(id);
  throw new UserError('err.unknownAction');
}

/** Pay everything still owed on a transaction. */
function markPaid(id, method, userId = null) {
  return payments.recordPayment(id, { method }, userId);
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
