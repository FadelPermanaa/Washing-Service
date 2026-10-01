// Expenses and supplies (stock). Buying supplies can create the expense automatically, and supplies that are
// used on every wash (e.g. shampoo) are deducted when a wash is finished.
const { db, now, today, tx } = require('../db');
const { UserError, toInt, clean } = require('./common');

const EXPENSE_CATEGORIES = ['supplies', 'utilities', 'salary', 'rent', 'equipment', 'marketing', 'other'];

/** "1,5" / "1.5" / "2" -> number rounded to 3 decimals, or NaN. */
function toQty(v) {
  const n = Number.parseFloat(String(v ?? '').trim().replace(',', '.'));
  return Number.isFinite(n) ? Math.round(n * 1000) / 1000 : NaN;
}

const validDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d || '') && !Number.isNaN(new Date(`${d}T00:00:00`).getTime());

// ---------- Expenses ----------

function addExpense({ date, category, amount, note }, userId) {
  const d = date || today();
  if (!validDate(d)) throw new UserError('err.date');
  if (!EXPENSE_CATEGORIES.includes(category)) throw new UserError('err.expenseCategory');
  const amt = toInt(amount);
  if (amt <= 0) throw new UserError('err.amount');
  return Number(db.prepare('INSERT INTO expenses (date, category, amount, note, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?)')
    .run(d, category, amt, clean(note, 200), now(), userId ?? null).lastInsertRowid);
}

function deleteExpense(id) {
  tx(() => {
    db.prepare('UPDATE stock_moves SET expense_id = NULL WHERE expense_id = ?').run(id);
    db.prepare('DELETE FROM expenses WHERE id = ?').run(id);
  });
}

function listExpenses(month) {
  return db.prepare(`SELECT e.*, u.name AS created_by_name FROM expenses e LEFT JOIN users u ON u.id = e.created_by
    WHERE substr(e.date, 1, 7) = ? ORDER BY e.date DESC, e.id DESC`).all(month);
}

function expensesByCategory(month) {
  return db.prepare(`SELECT category, COUNT(*) AS count, SUM(amount) AS total FROM expenses
    WHERE substr(date, 1, 7) = ? GROUP BY category ORDER BY total DESC`).all(month);
}

// ---------- Supplies ----------

function listSupplies({ includeInactive = false } = {}) {
  return db.prepare(`SELECT s.*, p.name AS usage_package_name, p.name_id AS usage_package_name_id,
      (s.stock <= s.min_stock AND s.min_stock > 0) AS low
    FROM supplies s LEFT JOIN packages p ON p.id = s.usage_package_id
    ${includeInactive ? '' : 'WHERE s.active = 1'} ORDER BY s.active DESC, low DESC, s.name`).all();
}

function lowStock() {
  return db.prepare('SELECT * FROM supplies WHERE active = 1 AND min_stock > 0 AND stock <= min_stock ORDER BY stock / min_stock').all();
}

function supplyInput(input) {
  const name = clean(input.name, 60);
  if (!name) throw new UserError('err.nameRequired');
  const minStock = toQty(input.min_stock || 0);
  const usage = toQty(input.usage_per_wash || 0);
  if (!(minStock >= 0) || !(usage >= 0)) throw new UserError('err.qty');
  const pkgId = toInt(input.usage_package_id) || null;
  if (pkgId && !db.prepare('SELECT 1 FROM packages WHERE id = ?').get(pkgId)) throw new UserError('err.choosePackage');
  return { name, nameId: clean(input.name_id, 60), unit: clean(input.unit, 12) || 'pcs', minStock, usage, pkgId };
}

function createSupply(input, userId) {
  const s = supplyInput(input);
  if (db.prepare('SELECT 1 FROM supplies WHERE name = ?').get(s.name)) throw new UserError('err.exists', { name: s.name });
  const start = toQty(input.stock || 0);
  if (!(start >= 0)) throw new UserError('err.qty');
  return tx(() => {
    const id = Number(db.prepare(`INSERT INTO supplies (name, name_id, unit, stock, min_stock, usage_per_wash, usage_package_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(s.name, s.nameId, s.unit, start, s.minStock, s.usage, s.pkgId, now()).lastInsertRowid);
    if (start > 0) {
      db.prepare("INSERT INTO stock_moves (supply_id, qty, reason, note, created_at, created_by) VALUES (?, ?, 'adjust', ?, ?, ?)")
        .run(id, start, 'opening stock', now(), userId ?? null);
    }
    return id;
  });
}

function updateSupply(id, input) {
  const s = supplyInput(input);
  if (db.prepare('SELECT 1 FROM supplies WHERE name = ? AND id != ?').get(s.name, id)) throw new UserError('err.exists', { name: s.name });
  db.prepare('UPDATE supplies SET name = ?, name_id = ?, unit = ?, min_stock = ?, usage_per_wash = ?, usage_package_id = ? WHERE id = ?')
    .run(s.name, s.nameId, s.unit, s.minStock, s.usage, s.pkgId, id);
}

function toggleSupply(id) {
  db.prepare('UPDATE supplies SET active = 1 - active WHERE id = ?').run(id);
}

/**
 * Change stock: 'purchase' adds (and can record the cost as an expense), 'usage' takes away,
 * 'adjust' sets the counted amount.
 */
function moveStock(supplyId, { type, qty, cost, note, recordExpense }, userId) {
  return tx(() => {
    const s = db.prepare('SELECT * FROM supplies WHERE id = ?').get(supplyId);
    if (!s) throw new UserError('err.supplyNotFound');
    const q = toQty(qty);
    if (!(q >= 0) || (type !== 'adjust' && q <= 0)) throw new UserError('err.qty');
    let change;
    let expenseId = null;
    if (type === 'purchase') {
      change = q;
      const amount = toInt(cost);
      if (recordExpense && amount > 0) {
        expenseId = addExpense({ date: today(), category: 'supplies', amount, note: `${s.name} +${q} ${s.unit}${note ? ` — ${note}` : ''}` }, userId);
      }
    } else if (type === 'usage') {
      if (q > s.stock + 1e-9) throw new UserError('err.stockNegative', { left: `${s.stock} ${s.unit}` });
      change = -q;
    } else if (type === 'adjust') {
      change = Math.round((q - s.stock) * 1000) / 1000;
    } else {
      throw new UserError('err.unknownAction');
    }
    db.prepare('UPDATE supplies SET stock = ROUND(stock + ?, 3) WHERE id = ?').run(change, s.id);
    db.prepare(`INSERT INTO stock_moves (supply_id, qty, reason, note, expense_id, created_at, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(s.id, change, type, clean(note, 120), expenseId, now(), userId ?? null);
    return { change, expenseId };
  });
}

function listMoves(supplyId, limit = 15) {
  return db.prepare(`SELECT m.*, u.name AS created_by_name, x.code AS tx_code FROM stock_moves m
    LEFT JOIN users u ON u.id = m.created_by LEFT JOIN transactions x ON x.id = m.transaction_id
    WHERE m.supply_id = ? ORDER BY m.id DESC LIMIT ?`).all(supplyId, limit);
}

/** Deduct supplies used automatically by a finished wash (never below zero). Runs inside finishWash. */
function consumeForWash(txId) {
  const t = db.prepare('SELECT package_id FROM transactions WHERE id = ?').get(txId);
  if (!t) return;
  const rows = db.prepare(`SELECT * FROM supplies WHERE active = 1 AND usage_per_wash > 0
    AND (usage_package_id IS NULL OR usage_package_id = ?)`).all(t.package_id);
  for (const s of rows) {
    const take = Math.min(s.usage_per_wash, Math.max(0, s.stock));
    db.prepare('UPDATE supplies SET stock = ROUND(MAX(0, stock - ?), 3) WHERE id = ?').run(s.usage_per_wash, s.id);
    db.prepare("INSERT INTO stock_moves (supply_id, qty, reason, transaction_id, created_at) VALUES (?, ?, 'wash', ?, ?)")
      .run(s.id, -take, txId, now());
  }
}

module.exports = {
  EXPENSE_CATEGORIES, toQty, addExpense, deleteExpense, listExpenses, expensesByCategory,
  listSupplies, lowStock, createSupply, updateSupply, toggleSupply, moveStock, listMoves, consumeForWash,
};
