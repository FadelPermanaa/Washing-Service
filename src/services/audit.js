// Activity log: a record of sensitive actions (prices, cancellations, discounts, payments, staff, settings…).
const { db, now } = require('../db');

/** Record an action. `detail` is a small object shown on the activity page. Never throws. */
function audit(userId, action, { entity = null, id = null, detail = null } = {}) {
  try {
    db.prepare('INSERT INTO audit_log (user_id, action, entity, entity_id, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(userId ?? null, action, entity, id ?? null, detail ? JSON.stringify(detail).slice(0, 1000) : null, now());
  } catch (err) {
    console.error('audit:', err.message);
  }
}

function listAudit({ userId, action, date } = {}) {
  const where = [];
  const params = [];
  if (userId) { where.push('a.user_id = ?'); params.push(userId); }
  if (action) { where.push('a.action LIKE ?'); params.push(`${action}%`); }
  if (date) { where.push('substr(a.created_at, 1, 10) = ?'); params.push(date); }
  return db.prepare(`SELECT a.*, u.name AS user_name, u.username FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY a.id DESC LIMIT 300`).all(...params)
    .map((r) => ({ ...r, detail: r.detail ? JSON.parse(r.detail) : null }));
}

function auditActions() {
  return db.prepare('SELECT DISTINCT action FROM audit_log ORDER BY action').all().map((r) => r.action);
}

module.exports = { audit, listAudit, auditActions };
