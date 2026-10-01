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

  // Profit = money received − expenses − washer commission earned this month.
  const expenses = db.prepare('SELECT COALESCE(SUM(amount), 0) AS n FROM expenses WHERE substr(date, 1, 7) = ?').get(m).n;
  const commission = byWasher.reduce((s, w) => s + w.commission, 0);
  const expensesByCategory = db.prepare(`SELECT category, SUM(amount) AS total FROM expenses WHERE substr(date, 1, 7) = ?
    GROUP BY category ORDER BY total DESC`).all(m);
  const profit = { revenue: totals.revenue, expenses, commission, net: totals.revenue - expenses - commission, expensesByCategory };

  // Busiest hours: cars arriving per weekday (0 = Sunday) and hour.
  const heat = db.prepare(`SELECT CAST(strftime('%w', created_at) AS INTEGER) AS dow, CAST(substr(created_at, 12, 2) AS INTEGER) AS hour, COUNT(*) AS n
    FROM transactions WHERE substr(created_at, 1, 7) = ? AND status != 'cancelled' GROUP BY dow, hour`).all(m);
  const hours = heat.length ? [Math.min(...heat.map((h) => h.hour)), Math.max(...heat.map((h) => h.hour))] : [8, 17];
  const busiest = { cells: Object.fromEntries(heat.map((h) => [`${h.dow}:${h.hour}`, h.n])), max: Math.max(1, ...heat.map((h) => h.n)), from: hours[0], to: hours[1] };

  return {
    month: m, byDay, byPackage, byType, byMethod, byWasher, loyalty: { ...loyalty }, memberships: { ...memberships }, byPromo, totals, profit, busiest,
  };
}

// ---------- CSV export ----------

const EXPORTS = {
  transactions: (m) => db.prepare(`
    SELECT x.code, x.created_at, v.plate, c.name AS customer, x.vehicle_type_name AS vehicle_type, x.package_name AS package,
      x.package_price, x.addons_total, x.membership_discount, x.free_discount, x.promo_code, x.promo_discount, x.discount, x.total,
      x.status, x.payment_status, x.payment_method,
      (SELECT COALESCE(SUM(amount), 0) FROM payments p WHERE p.transaction_id = x.id) AS paid,
      w.name AS washer, x.commission, x.started_at, x.finished_at
    FROM transactions x JOIN vehicles v ON v.id = x.vehicle_id LEFT JOIN customers c ON c.id = x.customer_id LEFT JOIN users w ON w.id = x.washer_id
    WHERE substr(x.created_at, 1, 7) = ? ORDER BY x.id`).all(m),
  payments: (m) => db.prepare(`
    SELECT p.created_at, p.amount, p.method, x.code AS transaction_code, mp.name AS membership_plan, u.name AS cashier
    FROM payments p LEFT JOIN transactions x ON x.id = p.transaction_id LEFT JOIN memberships ms ON ms.id = p.membership_id
    LEFT JOIN membership_plans mp ON mp.id = ms.plan_id LEFT JOIN users u ON u.id = p.created_by
    WHERE substr(p.created_at, 1, 7) = ? ORDER BY p.id`).all(m),
  expenses: (m) => db.prepare(`SELECT e.date, e.category, e.amount, e.note, u.name AS recorded_by FROM expenses e
    LEFT JOIN users u ON u.id = e.created_by WHERE substr(e.date, 1, 7) = ? ORDER BY e.date, e.id`).all(m),
  washers: (m) => monthlyReport(m).byWasher.map(({ name, count, revenue, commission, avg_minutes: avgMinutes }) => ({ washer: name, cars: count, revenue, commission, avg_minutes: avgMinutes })),
};

/**
 * Rows of one export as CSV text (UTF-8 with BOM so Excel shows Indonesian characters).
 * Indonesian Excel uses ";" as the list separator, English uses ",".
 */
function exportCsv(type, month, { sep = ',' } = {}) {
  const fn = EXPORTS[type];
  if (!fn) return null;
  const rows = fn(month).map((r) => ({ ...r }));
  const cols = rows.length ? Object.keys(rows[0]) : [];
  const cell = (v) => {
    if (v === null || v === undefined) return '';
    const str = String(v);
    // Guard against spreadsheet formula injection and quote when needed.
    const safe = /^[=+\-@\t\r]/.test(str) && !/^-?\d+(\.\d+)?$/.test(str) ? `'${str}` : str;
    return /["\n\r]/.test(safe) || safe.includes(sep) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  const lines = [cols.join(sep), ...rows.map((r) => cols.map((c) => cell(r[c])).join(sep))];
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

module.exports = { dashboardStats, monthlyReport, exportCsv, EXPORT_TYPES: Object.keys(EXPORTS) };
