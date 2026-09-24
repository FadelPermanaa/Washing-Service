const { db, now, today, tx } = require('./db');

class UserError extends Error {}

/** "b1234xyz" / "B-1234 xyz" -> "B 1234 XYZ" */
function normalizePlate(raw) {
  const compact = String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return compact.replace(/(?<=[A-Z])(?=\d)|(?<=\d)(?=[A-Z])/g, ' ');
}

function toInt(v, fallback = 0) {
  const n = Number.parseInt(String(v ?? '').replace(/[^\d-]/g, ''), 10);
  return Number.isFinite(n) ? n : fallback;
}

// ---------- Price list ----------

function getPriceList({ includeInactive = false } = {}) {
  const where = includeInactive ? '' : 'WHERE active = 1';
  const types = db.prepare(`SELECT * FROM vehicle_types ${where} ORDER BY sort_order, id`).all();
  const packages = db.prepare(`SELECT * FROM packages ${where} ORDER BY sort_order, id`).all();
  const addons = db.prepare(`SELECT * FROM addons ${where} ORDER BY name`).all();
  const prices = {};
  for (const row of db.prepare('SELECT * FROM package_prices').all()) {
    prices[`${row.package_id}:${row.vehicle_type_id}`] = row.price;
  }
  return { types, packages, addons, prices };
}

function quote({ vehicleTypeId, packageId, addonIds = [], discount = 0 }) {
  const type = db.prepare('SELECT * FROM vehicle_types WHERE id = ? AND active = 1').get(vehicleTypeId);
  if (!type) throw new UserError('Please choose a vehicle type.');
  const pkg = db.prepare('SELECT * FROM packages WHERE id = ? AND active = 1').get(packageId);
  if (!pkg) throw new UserError('Please choose a package.');
  const priceRow = db.prepare('SELECT price FROM package_prices WHERE package_id = ? AND vehicle_type_id = ?').get(pkg.id, type.id);
  if (!priceRow) throw new UserError(`"${pkg.name}" is not available for ${type.name}.`);

  const ids = [...new Set(addonIds.map((id) => toInt(id)).filter(Boolean))];
  const addons = ids.map((id) => db.prepare('SELECT * FROM addons WHERE id = ? AND active = 1').get(id)).filter(Boolean);
  const addonsTotal = addons.reduce((sum, a) => sum + a.price, 0);
  const subtotal = priceRow.price + addonsTotal;
  const disc = Math.min(Math.max(toInt(discount), 0), subtotal);
  return { type, pkg, packagePrice: priceRow.price, addons, addonsTotal, discount: disc, total: subtotal - disc };
}

// ---------- Vehicles ----------

function findVehicleByPlate(plate) {
  const p = normalizePlate(plate);
  if (!p) return null;
  const v = db.prepare(`
    SELECT v.*, c.name AS customer_name, c.phone AS customer_phone, t.name AS type_name,
      (SELECT COUNT(*) FROM transactions x WHERE x.vehicle_id = v.id AND x.status != 'cancelled') AS visits,
      (SELECT MAX(created_at) FROM transactions x WHERE x.vehicle_id = v.id) AS last_visit
    FROM vehicles v
    LEFT JOIN customers c ON c.id = v.customer_id
    JOIN vehicle_types t ON t.id = v.vehicle_type_id
    WHERE v.plate = ?`).get(p);
  return v ? { ...v } : null;
}

function listVehicles(q = '') {
  const like = `%${String(q).trim()}%`;
  return db.prepare(`
    SELECT v.*, c.name AS customer_name, c.phone AS customer_phone, t.name AS type_name,
      COUNT(x.id) AS visits, COALESCE(SUM(CASE WHEN x.payment_status = 'paid' THEN x.total END), 0) AS spent,
      MAX(x.created_at) AS last_visit
    FROM vehicles v
    LEFT JOIN customers c ON c.id = v.customer_id
    JOIN vehicle_types t ON t.id = v.vehicle_type_id
    LEFT JOIN transactions x ON x.vehicle_id = v.id AND x.status != 'cancelled'
    WHERE v.plate LIKE ? OR c.name LIKE ? OR c.phone LIKE ? OR v.brand_model LIKE ?
    GROUP BY v.id
    ORDER BY last_visit DESC NULLS LAST, v.id DESC
    LIMIT 200`).all(like, like, like, like);
}

// ---------- Transactions ----------

function nextCode() {
  const d = today().replace(/-/g, '').slice(2);
  const prefix = `WSH-${d}-`;
  const last = db.prepare('SELECT code FROM transactions WHERE code LIKE ? ORDER BY id DESC LIMIT 1').get(`${prefix}%`);
  const seq = last ? toInt(last.code.slice(prefix.length)) + 1 : 1;
  return prefix + String(seq).padStart(3, '0');
}

function createTransaction(input, userId) {
  const plate = normalizePlate(input.plate);
  if (!plate || plate.length < 3) throw new UserError('Please enter a valid plate number.');

  return tx(() => {
    const q = quote({
      vehicleTypeId: toInt(input.vehicle_type_id),
      packageId: toInt(input.package_id),
      addonIds: [].concat(input.addon_ids || []),
      discount: input.discount,
    });

    const name = String(input.customer_name || '').trim();
    const phone = String(input.customer_phone || '').trim();
    let vehicle = db.prepare('SELECT * FROM vehicles WHERE plate = ?').get(plate);
    let customerId = vehicle?.customer_id ?? null;

    if (name) {
      if (customerId) {
        db.prepare('UPDATE customers SET name = ?, phone = ? WHERE id = ?').run(name, phone || null, customerId);
      } else {
        customerId = Number(db.prepare('INSERT INTO customers (name, phone, created_at) VALUES (?, ?, ?)')
          .run(name, phone || null, now()).lastInsertRowid);
      }
    }

    const brand = String(input.brand_model || '').trim() || null;
    const color = String(input.color || '').trim() || null;
    if (vehicle) {
      db.prepare('UPDATE vehicles SET vehicle_type_id = ?, brand_model = COALESCE(?, brand_model), color = COALESCE(?, color), customer_id = ? WHERE id = ?')
        .run(q.type.id, brand, color, customerId, vehicle.id);
    } else {
      const id = db.prepare('INSERT INTO vehicles (plate, vehicle_type_id, brand_model, color, customer_id, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(plate, q.type.id, brand, color, customerId, now()).lastInsertRowid;
      vehicle = { id: Number(id) };
    }

    const paid = input.pay_now === 'on' || input.pay_now === '1';
    const method = paid ? String(input.payment_method || 'Cash') : null;
    const ts = now();
    const txId = Number(db.prepare(`
      INSERT INTO transactions (code, vehicle_id, customer_id, vehicle_type_id, vehicle_type_name, package_id, package_name,
        package_price, addons_total, discount, total, payment_status, payment_method, notes, created_by, created_at, paid_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      nextCode(), vehicle.id, customerId, q.type.id, q.type.name, q.pkg.id, q.pkg.name,
      q.packagePrice, q.addonsTotal, q.discount, q.total, paid ? 'paid' : 'unpaid', method,
      String(input.notes || '').trim() || null, userId, ts, paid ? ts : null,
    ).lastInsertRowid);

    for (const a of q.addons) {
      db.prepare('INSERT INTO transaction_addons (transaction_id, addon_id, name, price) VALUES (?, ?, ?, ?)').run(txId, a.id, a.name, a.price);
    }
    return txId;
  });
}

const TX_SELECT = `
  SELECT x.*, v.plate, v.brand_model, v.color, c.name AS customer_name, c.phone AS customer_phone, u.name AS cashier_name
  FROM transactions x
  JOIN vehicles v ON v.id = x.vehicle_id
  LEFT JOIN customers c ON c.id = x.customer_id
  LEFT JOIN users u ON u.id = x.created_by`;

function getTransaction(id) {
  const t = db.prepare(`${TX_SELECT} WHERE x.id = ?`).get(id);
  if (!t) return null;
  return { ...t, addons: db.prepare('SELECT * FROM transaction_addons WHERE transaction_id = ?').all(id) };
}

function listTransactions({ date, status, q } = {}) {
  const where = [];
  const params = [];
  if (date) { where.push('substr(x.created_at, 1, 10) = ?'); params.push(date); }
  if (status === 'unpaid') { where.push("x.payment_status = 'unpaid' AND x.status != 'cancelled'"); }
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

const TRANSITIONS = {
  start: { from: ['waiting'], to: 'washing', stamp: 'started_at' },
  finish: { from: ['washing'], to: 'done', stamp: 'finished_at' },
  cancel: { from: ['waiting', 'washing'], to: 'cancelled', stamp: null },
};

function changeStatus(id, action) {
  const rule = TRANSITIONS[action];
  if (!rule) throw new UserError('Unknown action.');
  const t = db.prepare('SELECT * FROM transactions WHERE id = ?').get(id);
  if (!t) throw new UserError('Transaction not found.');
  if (!rule.from.includes(t.status)) throw new UserError(`Cannot ${action} a transaction that is ${t.status}.`);
  if (action === 'cancel' && t.payment_status === 'paid') throw new UserError('Paid transactions cannot be cancelled.');
  const stamp = rule.stamp ? `, ${rule.stamp} = ?` : '';
  const params = rule.stamp ? [rule.to, now(), id] : [rule.to, id];
  db.prepare(`UPDATE transactions SET status = ?${stamp} WHERE id = ?`).run(...params);
}

const PAYMENT_METHODS = ['Cash', 'QRIS', 'Bank Transfer', 'Debit Card', 'E-Wallet'];

function markPaid(id, method) {
  if (!PAYMENT_METHODS.includes(method)) throw new UserError('Choose a payment method.');
  const t = db.prepare('SELECT * FROM transactions WHERE id = ?').get(id);
  if (!t) throw new UserError('Transaction not found.');
  if (t.status === 'cancelled') throw new UserError('This transaction was cancelled.');
  if (t.payment_status === 'paid') throw new UserError('Already paid.');
  db.prepare("UPDATE transactions SET payment_status = 'paid', payment_method = ?, paid_at = ? WHERE id = ?").run(method, now(), id);
}

/** Public status lookup — only exposes non-personal fields. */
function publicStatus(plate) {
  const p = normalizePlate(plate);
  if (!p) return null;
  return db.prepare(`
    SELECT x.code, x.status, x.package_name, x.created_at, x.started_at, x.finished_at
    FROM transactions x JOIN vehicles v ON v.id = x.vehicle_id
    WHERE v.plate = ? AND x.status != 'cancelled' AND substr(x.created_at, 1, 10) = ?
    ORDER BY x.id DESC`).all(p, today());
}

// ---------- Reports ----------

function dashboardStats() {
  const d = today();
  const s = db.prepare(`
    SELECT
      COUNT(CASE WHEN status != 'cancelled' THEN 1 END) AS vehicles,
      COALESCE(SUM(CASE WHEN payment_status = 'paid' THEN total END), 0) AS revenue,
      COALESCE(SUM(CASE WHEN payment_status = 'unpaid' AND status != 'cancelled' THEN total END), 0) AS outstanding,
      COUNT(CASE WHEN status = 'waiting' THEN 1 END) AS waiting,
      COUNT(CASE WHEN status = 'washing' THEN 1 END) AS washing,
      COUNT(CASE WHEN status = 'done' THEN 1 END) AS done
    FROM transactions WHERE substr(created_at, 1, 10) = ?`).get(d);
  return { ...s };
}

function monthlyReport(month) {
  const m = /^\d{4}-\d{2}$/.test(month || '') ? month : today().slice(0, 7);
  const byDay = db.prepare(`
    SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS vehicles,
      COALESCE(SUM(CASE WHEN payment_status = 'paid' THEN total END), 0) AS revenue
    FROM transactions WHERE substr(created_at, 1, 7) = ? AND status != 'cancelled'
    GROUP BY day ORDER BY day`).all(m);
  const byPackage = db.prepare(`
    SELECT package_name AS name, COUNT(*) AS count, COALESCE(SUM(CASE WHEN payment_status = 'paid' THEN total END), 0) AS revenue
    FROM transactions WHERE substr(created_at, 1, 7) = ? AND status != 'cancelled'
    GROUP BY package_name ORDER BY revenue DESC`).all(m);
  const byType = db.prepare(`
    SELECT vehicle_type_name AS name, COUNT(*) AS count
    FROM transactions WHERE substr(created_at, 1, 7) = ? AND status != 'cancelled'
    GROUP BY vehicle_type_name ORDER BY count DESC`).all(m);
  const byMethod = db.prepare(`
    SELECT payment_method AS name, COUNT(*) AS count, SUM(total) AS revenue
    FROM transactions WHERE substr(created_at, 1, 7) = ? AND payment_status = 'paid'
    GROUP BY payment_method ORDER BY revenue DESC`).all(m);
  const totals = byDay.reduce((acc, r) => ({ vehicles: acc.vehicles + r.vehicles, revenue: acc.revenue + r.revenue }), { vehicles: 0, revenue: 0 });
  return { month: m, byDay, byPackage, byType, byMethod, totals };
}

module.exports = {
  UserError, normalizePlate, toInt, PAYMENT_METHODS,
  getPriceList, quote, findVehicleByPlate, listVehicles,
  createTransaction, getTransaction, listTransactions, queue, changeStatus, markPaid, publicStatus,
  dashboardStats, monthlyReport,
};
