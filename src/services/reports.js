const { db, today } = require('../db');

function dashboardStats() {
  const s = db.prepare(`
    SELECT
      COUNT(CASE WHEN status != 'cancelled' THEN 1 END) AS vehicles,
      COALESCE(SUM(CASE WHEN payment_status = 'paid' THEN total END), 0) AS revenue,
      COALESCE(SUM(CASE WHEN payment_status = 'unpaid' AND status != 'cancelled' THEN total END), 0) AS outstanding,
      COUNT(CASE WHEN status = 'waiting' THEN 1 END) AS waiting,
      COUNT(CASE WHEN status = 'washing' THEN 1 END) AS washing,
      COUNT(CASE WHEN status = 'done' THEN 1 END) AS done
    FROM transactions WHERE substr(created_at, 1, 10) = ?`).get(today());
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
    SELECT package_name AS name, MAX(package_name_id) AS name_id, COUNT(*) AS count,
      COALESCE(SUM(CASE WHEN payment_status = 'paid' THEN total END), 0) AS revenue
    FROM transactions WHERE substr(created_at, 1, 7) = ? AND status != 'cancelled'
    GROUP BY package_name ORDER BY revenue DESC`).all(m);
  const byType = db.prepare(`
    SELECT vehicle_type_name AS name, MAX(vehicle_type_name_id) AS name_id, COUNT(*) AS count
    FROM transactions WHERE substr(created_at, 1, 7) = ? AND status != 'cancelled'
    GROUP BY vehicle_type_name ORDER BY count DESC`).all(m);
  const byMethod = db.prepare(`
    SELECT payment_method AS name, COUNT(*) AS count, SUM(total) AS revenue
    FROM transactions WHERE substr(created_at, 1, 7) = ? AND payment_status = 'paid'
    GROUP BY payment_method ORDER BY revenue DESC`).all(m);
  const totals = byDay.reduce((acc, r) => ({ vehicles: acc.vehicles + r.vehicles, revenue: acc.revenue + r.revenue }), { vehicles: 0, revenue: 0 });
  return { month: m, byDay, byPackage, byType, byMethod, totals };
}

module.exports = { dashboardStats, monthlyReport };
