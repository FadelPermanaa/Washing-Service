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

const { flashText } = require('./helpers');
const lastTx = () => env.db.prepare('SELECT * FROM transactions ORDER BY id DESC LIMIT 1').get();

async function wash(fields) {
  await admin.get('/app/transactions/new?lang=en');
  const r = await admin.postAndFollow('/app/transactions', { vehicle_type_id: 2, package_id: 2, ...fields });
  return { tx: lastTx(), page: r };
}

test('part payments, overpay protection and mixed methods', async () => {
  const { tx } = await wash({ plate: 'B 3 PART' }); // Full Wash, City Car = 50.000
  assert.equal(tx.total, 50000);
  await admin.get(`/app/transactions/${tx.id}`);
  await admin.post(`/app/transactions/${tx.id}/payments`, { amount: 20000, method: 'Cash' });
  let row = env.db.prepare('SELECT payment_status FROM transactions WHERE id = ?').get(tx.id);
  assert.equal(row.payment_status, 'unpaid');
  const page = await admin.get(`/app/transactions/${tx.id}?lang=en`);
  assert.match(page.text, /Part paid/);
  assert.match(page.text, /Still owed: Rp 30\.000/);

  const over = await admin.postAndFollow(`/app/transactions/${tx.id}/payments`, { amount: 40000, method: 'Cash' });
  assert.match(flashText(over.text).text, /more than what is still owed/);

  // a part-paid wash cannot be cancelled
  const cancel = await admin.postAndFollow(`/app/transactions/${tx.id}/status`, { action: 'cancel' });
  assert.equal(flashText(cancel.text).type, 'error');

  await admin.post(`/app/transactions/${tx.id}/payments`, { amount: 30000, method: 'QRIS' });
  row = env.db.prepare('SELECT payment_status, payment_method FROM transactions WHERE id = ?').get(tx.id);
  assert.deepEqual({ ...row }, { payment_status: 'paid', payment_method: 'Mixed' });
});

test('promo codes: percent, minimum spend, usage limit, bad codes', async () => {
  await admin.get('/app/promos');
  await admin.post('/app/promos', { code: 'hemat20', type: 'percent', value: 20, min_spend: 0 });
  await admin.post('/app/promos', { code: 'BIG', type: 'fixed', value: 30000, min_spend: 100000 });
  await admin.post('/app/promos', { code: 'ONCE', type: 'fixed', value: 5000, max_uses: 1 });

  let { tx } = await wash({ plate: 'B 4 PRO', promo_code: 'Hemat20' });
  assert.equal(tx.promo_code, 'HEMAT20');
  assert.equal(tx.promo_discount, 10000);
  assert.equal(tx.total, 40000);

  const small = await wash({ plate: 'B 5 PRO', promo_code: 'BIG' });
  assert.match(flashText(small.page.text).text, /minimum spend of Rp 100\.000/);

  await wash({ plate: 'B 6 PRO', promo_code: 'ONCE' });
  const twice = await wash({ plate: 'B 7 PRO', promo_code: 'ONCE' });
  assert.match(flashText(twice.page.text).text, /used up/);

  const bad = await wash({ plate: 'B 8 PRO', promo_code: 'NOPE' });
  assert.match(flashText(bad.page.text).text, /NOPE is not valid/);

  // live preview reports the problem instead of failing
  const r = await admin.get('/app/api/quote?vehicle_type_id=2&package_id=2&promo_code=NOPE&lang=en');
  const q = JSON.parse(r.text);
  assert.equal(q.ok, true);
  assert.equal(q.total, 50000);
  assert.match(q.promoError, /not valid/);
  ({ tx } = { tx: null });
});

test('stamp card: earn stamps, redeem a free wash, give back on cancel', async () => {
  await admin.get('/app/settings');
  await admin.post('/app/settings/loyalty', { stamp_every: 3 });
  for (let i = 0; i < 3; i++) await wash({ plate: 'B 9 STP', pay_now: '1', payment_method: 'Cash' });
  const v = () => env.db.prepare("SELECT stamps FROM vehicles WHERE plate = 'B 9 STP'").get().stamps;
  assert.equal(v(), 3);

  const q = JSON.parse((await admin.get('/app/api/quote?vehicle_type_id=2&package_id=2&plate=B9STP')).text);
  assert.equal(q.stamps.available, true);

  const { tx } = await wash({ plate: 'B 9 STP', use_stamp: '1', addon_ids: [1] }); // + Tire Shine 10.000
  assert.equal(tx.free_discount, 50000);
  assert.equal(tx.total, 10000);
  assert.equal(tx.stamp_earned, 0);
  assert.equal(v(), 0);

  await admin.get('/app/queue');
  await admin.post(`/app/transactions/${tx.id}/status`, { action: 'cancel' });
  assert.equal(v(), 3, 'stamps come back when the free wash is cancelled');
});

test('memberships: sell, use, auto-paid when nothing is owed, give back on cancel', async () => {
  await admin.get('/app/memberships');
  await admin.post('/app/membership-plans', { name: 'Full Wash 3x', name_id: 'Cuci Luar Dalam 3x', package_id: 2, vehicle_type_id: 2, washes: 3, valid_days: 30, price: 120000 });
  const plan = env.db.prepare('SELECT * FROM membership_plans ORDER BY id DESC LIMIT 1').get();
  await admin.post('/app/memberships', { plate: 'b 10 mem', plan_id: plan.id, method: 'QRIS', customer_name: 'Mira' });
  const m = env.db.prepare('SELECT * FROM memberships ORDER BY id DESC LIMIT 1').get();
  assert.equal(m.washes_left, 3);
  const pay = env.db.prepare('SELECT amount, method FROM payments WHERE membership_id = ?').get(m.id);
  assert.deepEqual({ ...pay }, { amount: 120000, method: 'QRIS' });

  const { tx } = await wash({ plate: 'B 10 MEM', use_membership: '1' });
  assert.equal(tx.membership_id, m.id);
  assert.equal(tx.total, 0);
  assert.equal(tx.payment_status, 'paid');
  assert.equal(tx.stamp_earned, 0);
  assert.equal(env.db.prepare('SELECT washes_left FROM memberships WHERE id = ?').get(m.id).washes_left, 2);

  // a different package is not covered
  const other = await wash({ plate: 'B 10 MEM', package_id: 1, use_membership: '1' });
  assert.equal(other.tx.membership_id, null);

  await admin.get('/app/queue');
  await admin.post(`/app/transactions/${tx.id}/status`, { action: 'cancel' });
  assert.equal(env.db.prepare('SELECT washes_left FROM memberships WHERE id = ?').get(m.id).washes_left, 3);
});

test('cashiers sell memberships but cannot manage promos, plans or cancel memberships', async () => {
  await admin.get('/app/users');
  await admin.post('/app/users', { name: 'Kasir', username: 'kasir4', password: 'secret1', role: 'cashier' });
  const c = new Client(env.base);
  await c.login('kasir4', 'secret1');
  assert.equal((await c.get('/app/memberships')).status, 200);
  assert.equal((await c.get('/app/promos')).status, 403);
  assert.equal((await c.post('/app/membership-plans', { name: 'x' })).status, 403);
  const m = env.db.prepare('SELECT id FROM memberships LIMIT 1').get();
  assert.equal((await c.post(`/app/memberships/${m.id}/cancel`)).status, 403);
});

test('reports count money when it is received, including membership sales', async () => {
  const r = await admin.get('/app/reports?lang=en');
  const today = env.db.prepare('SELECT COALESCE(SUM(amount), 0) AS n FROM payments').get().n;
  assert.match(r.text, new RegExp(`Rp ${today.toLocaleString('id-ID').replace(/\./g, '\\.')}`));
  assert.match(r.text, /Membership sales/);
  assert.match(r.text, /HEMAT20/);
});
