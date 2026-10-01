// Promo codes, the stamp card (every Nth wash free) and prepaid memberships.
const { db, now, today, tx } = require('../db');
const settings = require('../settings');
const { UserError, toInt, clean, normalizePlate, PAYMENT_METHODS } = require('./common');
const { upsertVehicle } = require('./vehicles');

const rp = (n) => `Rp ${Number(n).toLocaleString('id-ID')}`;

// ---------- Promo codes ----------

function listPromos() {
  return db.prepare(`SELECT p.*, (SELECT COUNT(*) FROM transactions x WHERE x.promo_id = p.id AND x.status != 'cancelled') AS used
    FROM promos p ORDER BY p.active DESC, p.id DESC`).all();
}

/** Check a code against an amount; returns { promo, discount } or throws a UserError. */
function applyPromo(code, amount) {
  const c = String(code || '').trim();
  if (!c) return { promo: null, discount: 0 };
  const p = db.prepare('SELECT * FROM promos WHERE code = ? COLLATE NOCASE').get(c);
  if (!p || !p.active) throw new UserError('err.promoInvalid', { code: c.toUpperCase() });
  const d = today();
  if (p.starts_on && d < p.starts_on) throw new UserError('err.promoNotYet', { date: p.starts_on });
  if (p.ends_on && d > p.ends_on) throw new UserError('err.promoExpired');
  if (p.max_uses) {
    const used = db.prepare("SELECT COUNT(*) AS n FROM transactions WHERE promo_id = ? AND status != 'cancelled'").get(p.id).n;
    if (used >= p.max_uses) throw new UserError('err.promoUsedUp');
  }
  if (amount < p.min_spend) throw new UserError('err.promoMinSpend', { min: rp(p.min_spend) });
  const discount = p.type === 'percent' ? Math.round((amount * p.value) / 100) : p.value;
  return { promo: p, discount: Math.min(discount, amount) };
}

function createPromo(input) {
  const code = String(input.code || '').trim().toUpperCase().replace(/\s+/g, '');
  if (!/^[A-Z0-9_-]{3,20}$/.test(code)) throw new UserError('err.promoCode');
  const type = input.type === 'fixed' ? 'fixed' : 'percent';
  const value = toInt(input.value);
  if (value <= 0 || (type === 'percent' && value > 100)) throw new UserError('err.promoValue');
  const dateOk = (v) => !v || /^\d{4}-\d{2}-\d{2}$/.test(v);
  if (!dateOk(input.starts_on) || !dateOk(input.ends_on)) throw new UserError('err.promoDates');
  if (input.starts_on && input.ends_on && input.starts_on > input.ends_on) throw new UserError('err.promoDates');
  if (db.prepare('SELECT 1 FROM promos WHERE code = ? COLLATE NOCASE').get(code)) throw new UserError('err.exists', { name: code });
  db.prepare(`INSERT INTO promos (code, description, type, value, min_spend, starts_on, ends_on, max_uses, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(code, clean(input.description, 120), type, value, Math.max(0, toInt(input.min_spend)),
    input.starts_on || null, input.ends_on || null, toInt(input.max_uses) > 0 ? toInt(input.max_uses) : null, now());
  return code;
}

function togglePromo(id) {
  db.prepare('UPDATE promos SET active = 1 - active WHERE id = ?').run(id);
}

// ---------- Stamp card ----------

const stampEvery = () => Math.max(0, settings.int('stamp_every'));

function stampStatus(vehicle) {
  const every = stampEvery();
  const have = vehicle?.stamps || 0;
  return { every, have, available: every > 0 && have >= every };
}

// ---------- Memberships ----------

function listPlans({ activeOnly = false } = {}) {
  return db.prepare(`SELECT mp.*, p.name AS package_name, p.name_id AS package_name_id, v.name AS type_name, v.name_id AS type_name_id,
      (SELECT COUNT(*) FROM memberships m WHERE m.plan_id = mp.id) AS sold
    FROM membership_plans mp JOIN packages p ON p.id = mp.package_id LEFT JOIN vehicle_types v ON v.id = mp.vehicle_type_id
    ${activeOnly ? 'WHERE mp.active = 1' : ''} ORDER BY mp.active DESC, mp.price`).all();
}

function createPlan(input) {
  const name = clean(input.name, 60);
  if (!name) throw new UserError('err.nameRequired');
  const pkg = db.prepare('SELECT id FROM packages WHERE id = ?').get(toInt(input.package_id));
  if (!pkg) throw new UserError('err.choosePackage');
  const typeId = toInt(input.vehicle_type_id) || null;
  if (typeId && !db.prepare('SELECT 1 FROM vehicle_types WHERE id = ?').get(typeId)) throw new UserError('err.chooseType');
  const washes = toInt(input.washes);
  const days = toInt(input.valid_days);
  const price = toInt(input.price);
  if (washes < 1 || washes > 100 || days < 1 || days > 730 || price < 0) throw new UserError('err.planNumbers');
  db.prepare(`INSERT INTO membership_plans (name, name_id, package_id, vehicle_type_id, washes, valid_days, price, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(name, clean(input.name_id, 60), pkg.id, typeId, washes, days, price, now());
}

function togglePlan(id) {
  db.prepare('UPDATE membership_plans SET active = 1 - active WHERE id = ?').run(id);
}

const MEMBERSHIP_SELECT = `
  SELECT m.*, mp.name AS plan_name, mp.name_id AS plan_name_id, mp.package_id, mp.vehicle_type_id AS plan_type_id,
    p.name AS package_name, p.name_id AS package_name_id, v.plate, c.name AS customer_name, c.phone AS customer_phone
  FROM memberships m
  JOIN membership_plans mp ON mp.id = m.plan_id
  JOIN packages p ON p.id = mp.package_id
  JOIN vehicles v ON v.id = m.vehicle_id
  LEFT JOIN customers c ON c.id = v.customer_id`;

function listMemberships(q = '') {
  const like = `%${String(q).trim()}%`;
  return db.prepare(`${MEMBERSHIP_SELECT} WHERE v.plate LIKE ? OR c.name LIKE ? ORDER BY
    (m.status = 'active' AND m.washes_left > 0 AND m.expires_on >= ?) DESC, m.id DESC LIMIT 200`).all(like, like, today());
}

/** Active memberships for a vehicle (not expired, washes left). */
function activeMemberships(vehicleId) {
  if (!vehicleId) return [];
  return db.prepare(`${MEMBERSHIP_SELECT} WHERE m.vehicle_id = ? AND m.status = 'active' AND m.washes_left > 0 AND m.expires_on >= ?
    ORDER BY m.expires_on`).all(vehicleId, today());
}

/** The membership that covers this package for this vehicle, if any. */
function coveringMembership(vehicleId, packageId, vehicleTypeId) {
  return activeMemberships(vehicleId).find((m) => m.package_id === packageId && (!m.plan_type_id || m.plan_type_id === vehicleTypeId)) || null;
}

function sellMembership(input, userId) {
  const plate = normalizePlate(input.plate);
  if (!plate || plate.length < 3) throw new UserError('err.plate');
  if (!PAYMENT_METHODS.includes(input.method)) throw new UserError('err.chooseMethod');
  return tx(() => {
    const plan = db.prepare('SELECT * FROM membership_plans WHERE id = ? AND active = 1').get(toInt(input.plan_id));
    if (!plan) throw new UserError('err.choosePlan');
    const existing = db.prepare('SELECT * FROM vehicles WHERE plate = ?').get(plate);
    const typeId = plan.vehicle_type_id || toInt(input.vehicle_type_id) || existing?.vehicle_type_id;
    if (!typeId || !db.prepare('SELECT 1 FROM vehicle_types WHERE id = ?').get(typeId)) throw new UserError('err.chooseType');
    if (plan.vehicle_type_id && existing && existing.vehicle_type_id !== plan.vehicle_type_id) throw new UserError('err.planType');
    const { vehicleId } = upsertVehicle({
      plate, vehicleTypeId: typeId, customerName: input.customer_name, customerPhone: input.customer_phone,
    });
    const start = today();
    const end = new Date(`${start}T00:00:00`);
    end.setDate(end.getDate() + plan.valid_days - 1);
    const expires = now(end).slice(0, 10);
    const id = Number(db.prepare(`INSERT INTO memberships (plan_id, vehicle_id, washes_total, washes_left, starts_on, expires_on, price, created_at, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(plan.id, vehicleId, plan.washes, plan.washes, start, expires, plan.price, now(), userId).lastInsertRowid);
    if (plan.price > 0) {
      db.prepare('INSERT INTO payments (membership_id, amount, method, created_at, created_by) VALUES (?, ?, ?, ?, ?)')
        .run(id, plan.price, input.method, now(), userId);
    }
    return id;
  });
}

function cancelMembership(id) {
  const m = db.prepare('SELECT * FROM memberships WHERE id = ?').get(id);
  if (!m) throw new UserError('err.membershipNotFound');
  db.prepare("UPDATE memberships SET status = 'cancelled' WHERE id = ?").run(id);
}

module.exports = {
  listPromos, applyPromo, createPromo, togglePromo,
  stampEvery, stampStatus,
  listPlans, createPlan, togglePlan, listMemberships, activeMemberships, coveringMembership, sellMembership, cancelMembership,
};
