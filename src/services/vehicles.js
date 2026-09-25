const { db, now } = require('../db');
const { normalizePlate } = require('./common');

const VEHICLE_SELECT = `
  SELECT v.*, c.name AS customer_name, c.phone AS customer_phone, t.name AS type_name, t.name_id AS type_name_id
  FROM vehicles v
  LEFT JOIN customers c ON c.id = v.customer_id
  JOIN vehicle_types t ON t.id = v.vehicle_type_id`;

function findVehicleByPlate(plate) {
  const p = normalizePlate(plate);
  if (!p) return null;
  const v = db.prepare(`${VEHICLE_SELECT} WHERE v.plate = ?`).get(p);
  if (!v) return null;
  const stats = db.prepare(`SELECT COUNT(*) AS visits, MAX(created_at) AS last_visit
    FROM transactions WHERE vehicle_id = ? AND status != 'cancelled'`).get(v.id);
  return { ...v, ...stats };
}

function listVehicles(q = '') {
  const like = `%${String(q).trim()}%`;
  return db.prepare(`
    SELECT v.*, c.name AS customer_name, c.phone AS customer_phone, t.name AS type_name, t.name_id AS type_name_id,
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

/**
 * Find or create the vehicle (and its customer) for a plate, updating details that were given.
 * Must run inside a transaction.
 */
function upsertVehicle({ plate, vehicleTypeId, brandModel, color, customerName, customerPhone }) {
  const name = String(customerName || '').trim();
  const phone = String(customerPhone || '').trim();
  let vehicle = db.prepare('SELECT * FROM vehicles WHERE plate = ?').get(plate);
  let customerId = vehicle?.customer_id ?? null;

  if (name) {
    if (customerId) {
      db.prepare('UPDATE customers SET name = ?, phone = COALESCE(?, phone) WHERE id = ?').run(name, phone || null, customerId);
    } else {
      customerId = Number(db.prepare('INSERT INTO customers (name, phone, created_at) VALUES (?, ?, ?)').run(name, phone || null, now()).lastInsertRowid);
    }
  } else if (phone && customerId) {
    db.prepare('UPDATE customers SET phone = ? WHERE id = ?').run(phone, customerId);
  }

  const brand = String(brandModel || '').trim() || null;
  const col = String(color || '').trim() || null;
  if (vehicle) {
    db.prepare('UPDATE vehicles SET vehicle_type_id = ?, brand_model = COALESCE(?, brand_model), color = COALESCE(?, color), customer_id = ? WHERE id = ?')
      .run(vehicleTypeId, brand, col, customerId, vehicle.id);
    return { vehicleId: vehicle.id, customerId };
  }
  const id = Number(db.prepare('INSERT INTO vehicles (plate, vehicle_type_id, brand_model, color, customer_id, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(plate, vehicleTypeId, brand, col, customerId, now()).lastInsertRowid);
  return { vehicleId: id, customerId };
}

module.exports = { findVehicleByPlate, listVehicles, upsertVehicle };
