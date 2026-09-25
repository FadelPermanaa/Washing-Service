const test = require('node:test');
const assert = require('node:assert/strict');
const { bootApp, Client, flashText } = require('./helpers');

let env;
test.before(async () => { env = await bootApp(); });
test.after(async () => { await env.close(); });

test('public pages render in Indonesian by default and English on request', async () => {
  const c = new Client(env.base);
  const id = await c.get('/');
  assert.equal(id.status, 200);
  assert.match(id.text, /<html lang="id">/);
  assert.match(id.text, /Kendaraan kinclong/);
  assert.match(id.text, /Cuci Luar Dalam/);
  const en = await c.get('/?lang=en');
  assert.match(en.text, /<html lang="en">/);
  assert.match(en.text, /A spotless ride/);
  // the choice is remembered in a cookie
  const again = await c.get('/');
  assert.match(again.text, /<html lang="en">/);
});

test('staff pages require login', async () => {
  const c = new Client(env.base);
  const r = await c.get('/app');
  assert.equal(r.status, 302);
  assert.match(r.location, /^\/login\?next=/);
});

test('POST without a CSRF token is rejected', async () => {
  const c = new Client(env.base);
  await c.get('/login');
  const r = await c.request('POST', '/login', { form: { username: 'admin', password: 'admin123', _csrf: 'wrong' } });
  assert.equal(r.status, 403);
});

test('login rejects a wrong password and accepts the right one', async () => {
  const c = new Client(env.base);
  await c.get('/login');
  const bad = await c.post('/login', { username: 'admin', password: 'nope' });
  assert.equal(bad.status, 401);
  const ok = await c.post('/login', { username: 'admin', password: 'admin123' });
  assert.equal(ok.status, 302);
  assert.equal(ok.location, '/app');
});

test('login does not redirect off-site', async () => {
  const c = new Client(env.base);
  await c.get('/login');
  const r = await c.post('/login', { username: 'admin', password: 'admin123', next: '//evil.example/app' });
  assert.equal(r.location, '/app');
});

test('every staff page renders in both languages', async () => {
  const c = new Client(env.base);
  await c.login();
  const pages = ['/app', '/app/queue', '/app/transactions/new', '/app/transactions', '/app/vehicles', '/app/reports', '/app/prices', '/app/users'];
  for (const lang of ['id', 'en']) {
    await c.get(`/app?lang=${lang}`);
    for (const p of pages) {
      const r = await c.get(p);
      assert.equal(r.status, 200, `${p} (${lang})`);
      assert.doesNotMatch(r.text, /\b(?:nav|err|flash|kpi|dash|tx|new|sum|rep|prices|users|col)\.[a-z]+[A-Za-z]*\b(?![^<]*>)/, `untranslated key on ${p} (${lang})`);
    }
  }
});

test('create a wash, move it through the queue and pay', async () => {
  const c = new Client(env.base);
  await c.login();
  await c.get('/app/transactions/new?lang=id');
  const created = await c.post('/app/transactions', {
    plate: 'b 1234 xyz', vehicle_type_id: 3, package_id: 2, addon_ids: [1, 2], discount: 5000, customer_name: 'Budi',
  });
  assert.equal(created.status, 302);
  const tx = env.db.prepare("SELECT * FROM transactions ORDER BY id DESC LIMIT 1").get();
  assert.equal(tx.package_price, 60000);
  assert.equal(tx.addons_total, 45000);
  assert.equal(tx.total, 100000);
  assert.equal(tx.package_name_id, 'Cuci Luar Dalam');

  const early = await c.postAndFollow(`/app/transactions/${tx.id}/status`, { action: 'finish' });
  assert.match(flashText(early.text).text, /tidak bisa dilakukan/);

  await c.post(`/app/transactions/${tx.id}/status`, { action: 'start' });
  await c.post(`/app/transactions/${tx.id}/pay`, { method: 'QRIS' });
  await c.post(`/app/transactions/${tx.id}/status`, { action: 'finish' });
  const after = env.db.prepare('SELECT status, payment_status, payment_method FROM transactions WHERE id = ?').get(tx.id);
  assert.deepEqual({ ...after }, { status: 'done', payment_status: 'paid', payment_method: 'QRIS' });

  const cancel = await c.postAndFollow(`/app/transactions/${tx.id}/status`, { action: 'cancel' });
  assert.equal(flashText(cancel.text).type, 'error');
});

test('server rejects a package that is not offered for the vehicle type', async () => {
  const c = new Client(env.base);
  await c.login();
  await c.get('/app/transactions/new?lang=id');
  const r = await c.postAndFollow('/app/transactions', { plate: 'X1Y', vehicle_type_id: 1, package_id: 4 });
  assert.equal(flashText(r.text).text, 'Paket "Detailing Interior" tidak tersedia untuk Motor.');
});

test('cashiers cannot open admin pages', async () => {
  const admin = new Client(env.base);
  await admin.login();
  await admin.get('/app/users');
  await admin.post('/app/users', { name: 'Kasir Satu', username: 'kasir1', password: 'secret1', role: 'cashier' });
  const cashier = new Client(env.base);
  await cashier.login('kasir1', 'secret1');
  assert.equal((await cashier.get('/app/prices')).status, 403);
  assert.equal((await cashier.get('/app/users')).status, 403);
  assert.equal((await cashier.post('/app/prices', { price_1_1: 1 })).status, 403);
  assert.equal((await cashier.get('/app/queue')).status, 200);
});

test('customer names are escaped in pages', async () => {
  const c = new Client(env.base);
  await c.login();
  await c.get('/app/transactions/new');
  await c.post('/app/transactions', { plate: 'ZZ1', vehicle_type_id: 2, package_id: 1, customer_name: '<script>alert(1)</script>' });
  const list = await c.get('/app/transactions?date=all&q=ZZ');
  assert.doesNotMatch(list.text, /<script>alert/);
});

test('admin can rename a catalog item in both languages', async () => {
  const c = new Client(env.base);
  await c.login();
  await c.get('/app/prices');
  await c.post('/app/catalog/addons/1/names', { name: 'Tire Shine', name_id: 'Semir Ban Premium' });
  const row = env.db.prepare('SELECT name_id FROM addons WHERE id = 1').get();
  assert.equal(row.name_id, 'Semir Ban Premium');
});
