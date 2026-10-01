const test = require('node:test');
const assert = require('node:assert/strict');
const { bootApp, Client } = require('./helpers');
const en = require('../src/i18n/en');

let env;
let admin;
test.before(async () => {
  env = await bootApp();
  admin = new Client(env.base);
  await admin.login();
});
test.after(async () => { await env.close(); });

const month = () => require('../src/db').today().slice(0, 7);

test('profit = money received − expenses − washer commission', async () => {
  await admin.get('/app/users');
  await admin.post('/app/users', { name: 'Joko', username: 'joko', password: 'secret1', role: 'washer', commission_type: 'fixed', commission_value: 10000 });
  const joko = env.db.prepare("SELECT id FROM users WHERE username = 'joko'").get().id;
  await admin.get('/app/transactions/new');
  await admin.post('/app/transactions', { plate: 'B 1 LABA', vehicle_type_id: 2, package_id: 2, pay_now: '1', payment_method: 'Cash' }); // 50.000
  const tx = env.db.prepare('SELECT id FROM transactions ORDER BY id DESC LIMIT 1').get();
  await admin.get('/app/queue');
  await admin.post(`/app/transactions/${tx.id}/status`, { action: 'start', washer_id: joko });
  await admin.post(`/app/transactions/${tx.id}/status`, { action: 'finish' });
  await admin.get('/app/expenses');
  await admin.post('/app/expenses', { category: 'utilities', amount: 15000 });

  const r = require('../src/services').monthlyReport(month());
  assert.deepEqual({ revenue: r.profit.revenue, expenses: r.profit.expenses, commission: r.profit.commission, net: r.profit.net },
    { revenue: 50000, expenses: 15000, commission: 10000, net: 25000 });
  const page = await admin.get('/app/reports?lang=en');
  assert.match(page.text, /Profit/);
  assert.match(page.text, /Rp 25\.000/);
  assert.match(page.text, /Busiest hours/);
});

test('cashiers see the report but not profit, exports or the activity log', async () => {
  await admin.get('/app/users');
  await admin.post('/app/users', { name: 'Kasir', username: 'kasir', password: 'secret1', role: 'cashier' });
  const c = new Client(env.base);
  await c.login('kasir', 'secret1');
  const page = await c.get('/app/reports?lang=en');
  assert.equal(page.status, 200);
  assert.doesNotMatch(page.text, /Money received minus expenses/);
  assert.doesNotMatch(page.text, /exports\//);
  assert.equal((await c.get(`/app/exports/transactions.csv?month=${month()}`)).status, 403);
  assert.equal((await c.get('/app/activity')).status, 403);
});

test('CSV export: Excel-friendly, separator by language, formula-safe', async () => {
  await admin.get('/app/transactions/new');
  await admin.post('/app/transactions', { plate: 'B 2 CSV', vehicle_type_id: 2, package_id: 1, customer_name: '=HYPERLINK("http://evil")', notes: 'x' });
  await admin.get('/app?lang=id');
  const id = await admin.get(`/app/exports/transactions.csv?month=${month()}`);
  assert.equal(id.status, 200);
  assert.match(id.headers.get('content-type'), /text\/csv/);
  assert.match(id.headers.get('content-disposition'), /attachment; filename="sparkle-transactions-\d{4}-\d{2}\.csv"/);
  const raw = Buffer.from(await (await fetch(`${env.base}/app/exports/transactions.csv?month=${month()}`, { headers: { cookie: admin.cookieHeader() } })).arrayBuffer());
  assert.deepEqual([...raw.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'UTF-8 BOM so Excel reads Indonesian text correctly');
  const lines = id.text.trim().split('\r\n');
  assert.ok(lines[0].startsWith('code;created_at;plate;customer'));
  assert.ok(lines.some((l) => l.includes(";\"'=HYPERLINK(\"\"http://evil\"\")\";")), 'formula is neutralised and quoted');

  await admin.get('/app?lang=en');
  const en2 = await admin.get(`/app/exports/payments.csv?month=${month()}`);
  assert.ok(en2.text.startsWith('created_at,amount,method'));
  assert.equal((await admin.get('/app/exports/secrets.csv')).status, 404);
  for (const type of require('../src/services').EXPORT_TYPES) {
    assert.equal((await admin.get(`/app/exports/${type}.csv?month=${month()}`)).status, 200, `${type} export works`);
  }
});

test('activity log records sensitive actions and failed sign-ins', async () => {
  const bad = new Client(env.base);
  await bad.get('/login');
  await bad.post('/login', { username: 'admin', password: 'wrong' });
  await admin.get('/app/prices');
  await admin.post('/app/prices', { price_1_1: 20000 });
  const unpaid = env.db.prepare("SELECT id FROM transactions WHERE payment_status = 'unpaid' LIMIT 1").get();
  await admin.get(`/app/transactions/${unpaid.id}`);
  await admin.post(`/app/transactions/${unpaid.id}/payments`, { amount: 5000, method: 'Cash' });
  const actions = env.db.prepare('SELECT DISTINCT action FROM audit_log').all().map((r) => r.action);
  for (const a of ['login', 'login.failed', 'prices.update', 'wash.create', 'wash.start', 'wash.finish', 'payment', 'expense.add', 'user.create', 'export']) {
    assert.ok(actions.includes(a), `missing ${a}`);
  }
  for (const a of actions) assert.ok(`act.a.${a}` in en, `no label for ${a}`);
  const page = await admin.get('/app/activity?lang=en&action=login.failed');
  assert.match(page.text, /Failed sign-in/);
  assert.match(page.text, /username: admin/);
});
