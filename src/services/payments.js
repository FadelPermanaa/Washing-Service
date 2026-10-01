// Payments: a transaction can be paid in one go, in parts, or with several methods.
const { db, now, tx } = require('../db');
const { UserError, toInt, PAYMENT_METHODS } = require('./common');

function paidAmount(txId) {
  return db.prepare('SELECT COALESCE(SUM(amount), 0) AS n FROM payments WHERE transaction_id = ?').get(txId).n;
}

function listPayments(txId) {
  return db.prepare(`SELECT p.*, u.name AS created_by_name FROM payments p LEFT JOIN users u ON u.id = p.created_by
    WHERE p.transaction_id = ? ORDER BY p.id`).all(txId);
}

/** Update payment_status / paid_at / payment_method from the payments recorded so far. */
function refreshPaymentStatus(txId) {
  const t = db.prepare('SELECT total FROM transactions WHERE id = ?').get(txId);
  const rows = db.prepare('SELECT method, created_at FROM payments WHERE transaction_id = ? ORDER BY id').all(txId);
  const paid = paidAmount(txId);
  const methods = [...new Set(rows.map((r) => r.method))];
  const method = methods.length === 1 ? methods[0] : (methods.length ? 'Mixed' : null);
  if (paid >= t.total) {
    db.prepare("UPDATE transactions SET payment_status = 'paid', payment_method = ?, paid_at = COALESCE(paid_at, ?) WHERE id = ?")
      .run(method, rows.at(-1)?.created_at || now(), txId);
  } else {
    db.prepare("UPDATE transactions SET payment_status = 'unpaid', payment_method = ?, paid_at = NULL WHERE id = ?").run(method, txId);
  }
}

/** Record a payment. `amount` defaults to everything still owed. */
function recordPayment(txId, { amount, method }, userId) {
  if (!PAYMENT_METHODS.includes(method)) throw new UserError('err.chooseMethod');
  return tx(() => {
    const t = db.prepare('SELECT * FROM transactions WHERE id = ?').get(txId);
    if (!t) throw new UserError('err.txNotFound');
    if (t.status === 'cancelled') throw new UserError('err.cancelled');
    const due = t.total - paidAmount(txId);
    if (due <= 0) throw new UserError('err.alreadyPaid');
    const amt = amount === undefined || amount === '' || amount === null ? due : toInt(amount);
    if (amt <= 0) throw new UserError('err.amount');
    if (amt > due) throw new UserError('err.overpay', { due: `Rp ${due.toLocaleString('id-ID')}` });
    db.prepare('INSERT INTO payments (transaction_id, amount, method, created_at, created_by) VALUES (?, ?, ?, ?, ?)')
      .run(txId, amt, method, now(), userId ?? null);
    refreshPaymentStatus(txId);
    return { paid: amt, due: due - amt };
  });
}

module.exports = { paidAmount, listPayments, recordPayment, refreshPaymentStatus };
