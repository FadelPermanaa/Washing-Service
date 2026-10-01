const test = require('node:test');
const assert = require('node:assert/strict');
const { bootApp, Client } = require('./helpers');

let env;
let admin;
test.before(async () => {
  env = await bootApp();
  admin = new Client(env.base);
  await admin.login();
});
test.after(async () => { await env.close(); });

test('paying at the counter records a payment row', async () => {
  await admin.get('/app/transactions/new');
  await admin.post('/app/transactions', { plate: 'B 1 PAY', vehicle_type_id: 2, package_id: 1, pay_now: '1', payment_method: 'QRIS' });
  const tx = env.db.prepare('SELECT * FROM transactions ORDER BY id DESC LIMIT 1').get();
  const rows = env.db.prepare('SELECT amount, method FROM payments WHERE transaction_id = ?').all(tx.id);
  assert.deepEqual(rows.map((r) => ({ ...r })), [{ amount: tx.total, method: 'QRIS' }]);
});

test('paying later from the queue records a payment row and marks it paid', async () => {
  await admin.get('/app/transactions/new');
  await admin.post('/app/transactions', { plate: 'B 2 PAY', vehicle_type_id: 2, package_id: 2 });
  const tx = env.db.prepare('SELECT * FROM transactions ORDER BY id DESC LIMIT 1').get();
  await admin.get('/app/queue');
  await admin.post(`/app/transactions/${tx.id}/pay`, { method: 'Cash' });
  const after = env.db.prepare('SELECT payment_status, payment_method FROM transactions WHERE id = ?').get(tx.id);
  assert.deepEqual({ ...after }, { payment_status: 'paid', payment_method: 'Cash' });
  assert.equal(env.db.prepare('SELECT SUM(amount) AS n FROM payments WHERE transaction_id = ?').get(tx.id).n, tx.total);
  // paying twice is refused
  await admin.post(`/app/transactions/${tx.id}/pay`, { method: 'Cash' });
  assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM payments WHERE transaction_id = ?').get(tx.id).n, 1);
});
