// Washers, wash bays, per-package checklists and commission.
const { db, now, today, tx } = require('../db');
const { UserError, toInt, clean } = require('./common');

// ---------- Washers & bays ----------

function listWashers({ activeOnly = true } = {}) {
  return db.prepare(`SELECT id, name, username, phone, commission_type, commission_value, active FROM users
    WHERE role = 'washer' ${activeOnly ? 'AND active = 1' : ''} ORDER BY name`).all();
}

function listBays({ activeOnly = true } = {}) {
  return db.prepare(`SELECT b.*, (SELECT x.id FROM transactions x WHERE x.bay_id = b.id AND x.status = 'washing' LIMIT 1) AS busy_tx
    FROM bays b ${activeOnly ? 'WHERE b.active = 1' : ''} ORDER BY b.sort_order, b.id`).all();
}

/** Commission earned for a wash of `total` rupiah by this washer. */
function commissionFor(washer, total) {
  if (!washer) return 0;
  if (washer.commission_type === 'percent') return Math.round((total * washer.commission_value) / 100);
  return washer.commission_value;
}

// ---------- Starting / finishing a wash ----------

function startWash(id, { washerId, bayId } = {}) {
  return tx(() => {
    const t = db.prepare('SELECT * FROM transactions WHERE id = ?').get(id);
    if (!t) throw new UserError('err.txNotFound');
    if (t.status !== 'waiting') throw new UserError('err.badTransition', { status: { key: `status.${t.status}` } });

    const wId = toInt(washerId) || null;
    if (wId && !db.prepare("SELECT 1 FROM users WHERE id = ? AND role = 'washer' AND active = 1").get(wId)) {
      throw new UserError('err.washerInvalid');
    }
    const bId = toInt(bayId) || null;
    if (bId) {
      const bay = db.prepare('SELECT * FROM bays WHERE id = ? AND active = 1').get(bId);
      if (!bay) throw new UserError('err.bayInvalid');
      const busy = db.prepare("SELECT x.code FROM transactions x WHERE x.bay_id = ? AND x.status = 'washing'").get(bId);
      if (busy) throw new UserError('err.bayBusy', { bay: bay.name, code: busy.code });
    }

    db.prepare("UPDATE transactions SET status = 'washing', started_at = ?, washer_id = ?, bay_id = ? WHERE id = ?").run(now(), wId, bId, id);
    db.prepare('DELETE FROM transaction_checks WHERE transaction_id = ?').run(id);
    const items = db.prepare('SELECT * FROM checklist_items WHERE package_id = ? ORDER BY sort_order, id').all(t.package_id);
    for (const it of items) {
      db.prepare('INSERT INTO transaction_checks (transaction_id, label, label_id, sort_order) VALUES (?, ?, ?, ?)').run(id, it.label, it.label_id, it.sort_order);
    }
  });
}

function finishWash(id) {
  return tx(() => {
    const t = db.prepare('SELECT * FROM transactions WHERE id = ?').get(id);
    if (!t) throw new UserError('err.txNotFound');
    if (t.status !== 'washing') throw new UserError('err.badTransition', { status: { key: `status.${t.status}` } });
    const washer = t.washer_id ? db.prepare('SELECT * FROM users WHERE id = ?').get(t.washer_id) : null;
    db.prepare("UPDATE transactions SET status = 'done', finished_at = ?, commission = ? WHERE id = ?")
      .run(now(), commissionFor(washer, t.total), id);
    require('./notifications').notifyTransaction('tx_ready', id);
  });
}

// ---------- Checklist on a job ----------

function getChecks(txId) {
  return db.prepare(`SELECT c.*, u.name AS done_by_name FROM transaction_checks c
    LEFT JOIN users u ON u.id = c.done_by WHERE c.transaction_id = ? ORDER BY c.sort_order, c.id`).all(txId);
}

/** Can this signed-in user work on this job? Washers only on their own; cashiers and admins on any. */
function canWorkOn(user, t) {
  if (!user || !t) return false;
  if (user.role === 'washer') return t.washer_id === user.id;
  return true;
}

function toggleCheck(txId, checkId, user) {
  const t = db.prepare('SELECT * FROM transactions WHERE id = ?').get(txId);
  if (!t) throw new UserError('err.txNotFound');
  if (!canWorkOn(user, t)) throw new UserError('err.notYourJob');
  if (t.status !== 'washing') throw new UserError('err.checklistLocked');
  const c = db.prepare('SELECT * FROM transaction_checks WHERE id = ? AND transaction_id = ?').get(checkId, txId);
  if (!c) throw new UserError('err.txNotFound');
  if (c.done_at) db.prepare('UPDATE transaction_checks SET done_at = NULL, done_by = NULL WHERE id = ?').run(c.id);
  else db.prepare('UPDATE transaction_checks SET done_at = ?, done_by = ? WHERE id = ?').run(now(), user.id, c.id);
}

/** Checklist progress for many transactions at once: { [txId]: { done, total } }. */
function checkProgress(txIds) {
  if (!txIds.length) return {};
  const rows = db.prepare(`SELECT transaction_id, COUNT(*) AS total, COUNT(done_at) AS done FROM transaction_checks
    WHERE transaction_id IN (${txIds.map(() => '?').join(',')}) GROUP BY transaction_id`).all(...txIds);
  return Object.fromEntries(rows.map((r) => [r.transaction_id, { done: r.done, total: r.total }]));
}

// ---------- Washer's own jobs ----------

function jobsFor(washerId) {
  const d = today();
  const rows = db.prepare(`
    SELECT x.*, v.plate, v.brand_model, v.color, b.name AS bay_name
    FROM transactions x JOIN vehicles v ON v.id = x.vehicle_id LEFT JOIN bays b ON b.id = x.bay_id
    WHERE x.washer_id = ? AND (x.status = 'washing' OR (x.status = 'done' AND substr(x.finished_at, 1, 10) = ?))
    ORDER BY x.status = 'done', x.started_at DESC`).all(washerId, d);
  const month = d.slice(0, 7);
  const stats = db.prepare(`SELECT
      COUNT(CASE WHEN substr(finished_at, 1, 10) = ? THEN 1 END) AS today_count,
      COALESCE(SUM(CASE WHEN substr(finished_at, 1, 10) = ? THEN commission END), 0) AS today_commission,
      COUNT(*) AS month_count, COALESCE(SUM(commission), 0) AS month_commission
    FROM transactions WHERE washer_id = ? AND status = 'done' AND substr(finished_at, 1, 7) = ?`).get(d, d, washerId, month);
  return { active: rows.filter((r) => r.status === 'washing'), done: rows.filter((r) => r.status === 'done'), stats: { ...stats } };
}

// ---------- Checklist templates (admin) ----------

function packageChecklist(packageId) {
  return db.prepare('SELECT * FROM checklist_items WHERE package_id = ? ORDER BY sort_order, id').all(packageId);
}

function addChecklistItem(packageId, { label, labelId }) {
  const l = clean(label, 80);
  if (!l) throw new UserError('err.nameRequired');
  const next = db.prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM checklist_items WHERE package_id = ?').get(packageId).n;
  db.prepare('INSERT INTO checklist_items (package_id, label, label_id, sort_order) VALUES (?, ?, ?, ?)').run(packageId, l, clean(labelId, 80), next);
}

function updateChecklistItem(packageId, itemId, { label, labelId }) {
  const l = clean(label, 80);
  if (!l) throw new UserError('err.nameRequired');
  db.prepare('UPDATE checklist_items SET label = ?, label_id = ? WHERE id = ? AND package_id = ?').run(l, clean(labelId, 80), itemId, packageId);
}

function deleteChecklistItem(packageId, itemId) {
  db.prepare('DELETE FROM checklist_items WHERE id = ? AND package_id = ?').run(itemId, packageId);
}

/** Move an item one place up (-1) or down (+1). */
function moveChecklistItem(packageId, itemId, dir) {
  tx(() => {
    const items = packageChecklist(packageId);
    const i = items.findIndex((it) => it.id === itemId);
    const j = i + (dir < 0 ? -1 : 1);
    if (i < 0 || j < 0 || j >= items.length) return;
    [items[i], items[j]] = [items[j], items[i]];
    items.forEach((it, k) => db.prepare('UPDATE checklist_items SET sort_order = ? WHERE id = ?').run(k, it.id));
  });
}

module.exports = {
  listWashers, listBays, commissionFor, startWash, finishWash, getChecks, canWorkOn, toggleCheck, checkProgress, jobsFor,
  packageChecklist, addChecklistItem, updateChecklistItem, deleteChecklistItem, moveChecklistItem,
};
