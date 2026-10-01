const { db, today } = require('../db');

/** Money is counted when it is received (the payments table), so membership sales and partial payments are included. */
function dashboardStats() {
  const d = today();
  const s = db.prepare(`
    SELECT
      COUNT(CASE WHEN status != 'cancelled' THEN 1 END) AS vehicles,
      COUNT(CASE WHEN status = 'waiting' THEN 1 END) AS waiting,
      COUNT(CASE WHEN status = 'washing' THEN 1 END) AS washing,
      COUNT(CASE WHEN status = 'done' THEN 1 END) AS done
    FROM transactions WHERE substr(created_at, 1, 10) = ?`).get(d);
  const revenue = db.prepare('SELECT COALESCE(SUM(amount), 0) AS n FROM payments WHERE substr(created_at, 1, 10) = ?').get(d).n;
  const outstanding = db.prepare(`
    SELECT COALESCE(SUM(x.total - COALESCE((SELECT SUM(amount) FROM payments p WHERE p.transaction_id = x.id), 0)), 0) AS n
    FROM transactions x WHERE x.payment_status = 'unpaid' AND x.status != 'cancelled' AND substr(x.created_at, 1, 10) = ?`).get(d).n;
  return { ...s, revenue, outstanding };
}

function monthlyReport(month) {
  const m = /^\d{4}-\d{2}$/.test(month || '') ? month : today().slice(0, 7);
  const vehiclesByDay = db.prepare(`
    SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS vehicles
    FROM transactions WHERE substr(created_at, 1, 7) = ? AND status != 'cancelled' GROUP BY day`).all(m);
  const revenueByDay = db.prepare(`
    SELECT substr(created_at, 1, 10) AS day, SUM(amount) AS revenue
    FROM payments WHERE substr(created_at, 1, 7) = ? GROUP BY day`).all(m);
  const days = new Map();
  for (const r of vehiclesByDay) days.set(r.day, { day: r.day, vehicles: r.vehicles, revenue: 0 });
  for (const r of revenueByDay) days.set(r.day, { ...(days.get(r.day) || { day: r.day, vehicles: 0 }), revenue: r.revenue });
  const byDay = [...days.values()].sort((a, b) => a.day.localeCompare(b.day));

  const byPackage = db.prepare(`
    SELECT package_name AS name, MAX(package_name_id) AS name_id, COUNT(*) AS count,
      COALESCE(SUM(CASE WHEN payment_status = 'paid' THEN total END), 0) AS revenue
    FROM transactions WHERE substr(created_at, 1, 7) = ? AND status != 'cancelled'
    GROUP BY package_name ORDER BY count DESC`).all(m);
  const byType = db.prepare(`
    SELECT vehicle_type_name AS name, MAX(vehicle_type_name_id) AS name_id, COUNT(*) AS count
    FROM transactions WHERE substr(created_at, 1, 7) = ? AND status != 'cancelled'
    GROUP BY vehicle_type_name ORDER BY count DESC`).all(m);
  const byMethod = db.prepare(`
    SELECT method AS name, COUNT(*) AS count, SUM(amount) AS revenue
    FROM payments WHERE substr(created_at, 1, 7) = ? GROUP BY method ORDER BY revenue DESC`).all(m);
  const byWasher = db.prepare(`
    SELECT u.id, u.name, COUNT(x.id) AS count, COALESCE(SUM(x.total), 0) AS revenue, COALESCE(SUM(x.commission), 0) AS commission,
      CAST(ROUND(AVG((julianday(x.finished_at) - julianday(x.started_at)) * 1440)) AS INTEGER) AS avg_minutes
    FROM transactions x JOIN users u ON u.id = x.washer_id
    WHERE x.status = 'done' AND substr(x.finished_at, 1, 7) = ?
    GROUP BY u.id ORDER BY count DESC`).all(m);
  const loyalty = db.prepare(`
    SELECT
      COUNT(CASE WHEN promo_id IS NOT NULL THEN 1 END) AS promo_count, COALESCE(SUM(promo_discount), 0) AS promo_discount,
      COUNT(CASE WHEN free_discount > 0 THEN 1 END) AS free_count, COALESCE(SUM(free_discount), 0) AS free_value,
      COUNT(CASE WHEN membership_id IS NOT NULL THEN 1 END) AS membership_washes,
      COALESCE(SUM(discount), 0) AS manual_discount
    FROM transactions WHERE substr(created_at, 1, 7) = ? AND status != 'cancelled'`).get(m);
  const memberships = db.prepare(`
    SELECT COUNT(*) AS sold, COALESCE(SUM(amount), 0) AS revenue FROM payments
    WHERE membership_id IS NOT NULL AND substr(created_at, 1, 7) = ?`).get(m);
  const byPromo = db.prepare(`
    SELECT promo_code AS code, COUNT(*) AS count, SUM(promo_discount) AS discount FROM transactions
    WHERE promo_id IS NOT NULL AND status != 'cancelled' AND substr(created_at, 1, 7) = ? GROUP BY promo_code ORDER BY count DESC`).all(m);
  const totals = {
    vehicles: byDay.reduce((s, r) => s + r.vehicles, 0),
    revenue: byDay.reduce((s, r) => s + r.revenue, 0),
  };
  return { month: m, byDay, byPackage, byType, byMethod, byWasher, loyalty: { ...loyalty }, memberships: { ...memberships }, byPromo, totals };
}

module.exports = { dashboardStats, monthlyReport };
