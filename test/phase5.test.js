const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { bootApp, Client, flashText } = require('./helpers');

let env;
let admin;
let washer;
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]), Buffer.from('JFIF fake image body for tests')]);
const photo = (data = JPEG, filename = 'car.jpg', type = 'image/jpeg') => ({ name: 'photos', filename, type, data });

test.before(async () => {
  env = await bootApp();
  admin = new Client(env.base);
  await admin.login();
  await admin.get('/app/users');
  await admin.post('/app/users', { name: 'Joko', username: 'joko', password: 'secret1', role: 'washer' });
  await admin.post('/app/users', { name: 'Rina', username: 'rina', password: 'secret1', role: 'washer' });
  await admin.post('/app/users', { name: 'Kasir', username: 'kasir', password: 'secret1', role: 'cashier' });
  washer = new Client(env.base);
  await washer.login('joko', 'secret1');
});
test.after(async () => { await env.close(); });

const uid = (u) => env.db.prepare('SELECT id FROM users WHERE username = ?').get(u).id;

async function washingJob(plate, washerName = 'joko') {
  await admin.get('/app/transactions/new');
  await admin.post('/app/transactions', { plate, vehicle_type_id: 2, package_id: 1 });
  const tx = env.db.prepare('SELECT * FROM transactions ORDER BY id DESC LIMIT 1').get();
  await admin.get('/app/queue');
  await admin.post(`/app/transactions/${tx.id}/status`, { action: 'start', washer_id: uid(washerName) });
  return env.db.prepare('SELECT * FROM transactions WHERE id = ?').get(tx.id);
}

test('washer uploads a before photo; staff and the customer link can see it', async () => {
  const tx = await washingJob('B 1 FOTO');
  await washer.get(`/app/jobs/${tx.id}`);
  const r = await washer.upload(`/app/jobs/${tx.id}/photos`, { kind: 'before' }, [photo()], { accept: 'application/json' });
  assert.equal(r.status, 200, r.text);
  const p = env.db.prepare('SELECT * FROM transaction_photos WHERE transaction_id = ?').get(tx.id);
  assert.equal(p.kind, 'before');
  assert.equal(p.mime, 'image/jpeg');
  assert.ok(fs.existsSync(path.join(env.dir, 'uploads', p.filename)));

  const img = await washer.get(`/app/photos/${p.id}`);
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('content-type'), 'image/jpeg');

  const rina = new Client(env.base);
  await rina.login('rina', 'secret1');
  assert.equal((await rina.get(`/app/photos/${p.id}`)).status, 404, 'other washers cannot see it');

  const pub = new Client(env.base);
  assert.equal((await pub.get(`/t/${tx.token}/photos/${p.id}`)).status, 200);
  const page = await pub.get(`/t/${tx.token}?lang=en`);
  assert.match(page.text, new RegExp(`/t/${tx.token}/photos/${p.id}`));
  const other = await washingJob('B 2 FOTO');
  assert.equal((await pub.get(`/t/${other.token}/photos/${p.id}`)).status, 404, 'photo must belong to that wash');
});

test('fake images, huge files and missing CSRF are rejected', async () => {
  const tx = await washingJob('B 3 FOTO');
  await washer.get(`/app/jobs/${tx.id}?lang=en`);
  const fake = await washer.upload(`/app/jobs/${tx.id}/photos`, { kind: 'after' }, [photo(Buffer.from('<?php echo 1; ?> not an image'), 'evil.jpg')]);
  assert.equal(fake.status, 302);
  const shown = await washer.get(fake.location);
  assert.match(flashText(shown.text).text, /Only JPEG, PNG or WebP/);

  const big = await washer.upload(`/app/jobs/${tx.id}/photos`, { kind: 'after' }, [photo(Buffer.concat([JPEG, Buffer.alloc(9 * 1024 * 1024)]))]);
  const bigPage = await washer.get(big.location);
  assert.match(flashText(bigPage.text).text, /too large/);

  const noToken = await washer.upload(`/app/jobs/${tx.id}/photos`, { kind: 'after', _csrf: 'nope' }, [photo()]);
  assert.equal(noToken.status, 403);
  assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM transaction_photos WHERE transaction_id = ?').get(tx.id).n, 0);
});

test('washers add photos only while washing; cashiers can add later', async () => {
  const tx = await washingJob('B 4 FOTO');
  await washer.get(`/app/jobs/${tx.id}`);
  await washer.post(`/app/jobs/${tx.id}/finish`);
  await washer.get('/app/jobs');
  await washer.upload(`/app/jobs/${tx.id}/photos`, { kind: 'after' }, [photo()]);
  assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM transaction_photos WHERE transaction_id = ?').get(tx.id).n, 0);

  const cashier = new Client(env.base);
  await cashier.login('kasir', 'secret1');
  await cashier.get(`/app/transactions/${tx.id}`);
  await cashier.upload(`/app/transactions/${tx.id}/photos`, { kind: 'after', back: 'detail' }, [photo(), photo()]);
  assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM transaction_photos WHERE transaction_id = ?').get(tx.id).n, 2);
});

test('a washer deletes their own photo', async () => {
  const tx = await washingJob('B 5 FOTO');
  await washer.get(`/app/jobs/${tx.id}`);
  await washer.upload(`/app/jobs/${tx.id}/photos`, { kind: 'before' }, [photo()]);
  const p = env.db.prepare('SELECT * FROM transaction_photos WHERE transaction_id = ?').get(tx.id);
  await washer.get(`/app/jobs/${tx.id}`);
  await washer.post(`/app/photos/${p.id}/delete`);
  assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM transaction_photos WHERE id = ?').get(p.id).n, 0);
  assert.ok(!fs.existsSync(path.join(env.dir, 'uploads', p.filename)) || await new Promise((r) => setTimeout(() => r(!fs.existsSync(path.join(env.dir, 'uploads', p.filename))), 50)));
});

test('stock: finishing a wash uses supplies; purchases become expenses', async () => {
  await admin.get('/app/stock');
  await admin.post('/app/stock', { name: 'Car shampoo', name_id: 'Sampo mobil', unit: 'liter', stock: '10', min_stock: '2', usage_per_wash: '0,5' });
  await admin.post('/app/stock', { name: 'Interior cleaner', unit: 'botol', stock: '4', min_stock: '1', usage_per_wash: '1', usage_package_id: 4 });
  const shampoo = () => env.db.prepare("SELECT * FROM supplies WHERE name = 'Car shampoo'").get();
  const cleaner = () => env.db.prepare("SELECT * FROM supplies WHERE name = 'Interior cleaner'").get();

  const tx = await washingJob('B 6 STOK');
  await admin.post(`/app/transactions/${tx.id}/status`, { action: 'finish' });
  assert.equal(shampoo().stock, 9.5);
  assert.equal(cleaner().stock, 4, 'only used by the package it is set for');
  const move = env.db.prepare("SELECT * FROM stock_moves WHERE reason = 'wash'").get();
  assert.equal(move.transaction_id, tx.id);

  await admin.get('/app/stock');
  await admin.post(`/app/stock/${shampoo().id}/move`, { type: 'purchase', qty: '5', cost: 150000, record_expense: '1' });
  assert.equal(shampoo().stock, 14.5);
  const exp = env.db.prepare('SELECT * FROM expenses ORDER BY id DESC LIMIT 1').get();
  assert.equal(exp.category, 'supplies');
  assert.equal(exp.amount, 150000);

  const tooMuch = await admin.postAndFollow(`/app/stock/${shampoo().id}/move?lang=en`, { type: 'usage', qty: '100' });
  assert.equal(flashText(tooMuch.text).type, 'error');
  await admin.post(`/app/stock/${shampoo().id}/move`, { type: 'adjust', qty: '1.5' });
  assert.equal(shampoo().stock, 1.5);

  const dash = await admin.get('/app?lang=en');
  assert.match(dash.text, /Running low/);
  assert.match(dash.text, /Car shampoo/);
});

test('expenses: add, validate, delete', async () => {
  await admin.get('/app/expenses');
  await admin.post('/app/expenses', { date: '2026-10-05', category: 'utilities', amount: 450000, note: 'Listrik' });
  const bad = await admin.postAndFollow('/app/expenses', { date: '2026-10-05', category: 'casino', amount: 1 });
  assert.equal(flashText(bad.text).type, 'error');
  const e = env.db.prepare("SELECT * FROM expenses WHERE category = 'utilities'").get();
  assert.equal(e.amount, 450000);
  const page = await admin.get('/app/expenses?month=2026-10&lang=en');
  assert.match(page.text, /Electricity &amp; water/);
  await admin.post(`/app/expenses/${e.id}/delete`, { month: '2026-10' });
  assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM expenses WHERE id = ?').get(e.id).n, 0);
});

test('stock and expenses are admin only', async () => {
  const cashier = new Client(env.base);
  await cashier.login('kasir', 'secret1');
  assert.equal((await cashier.get('/app/stock')).status, 403);
  assert.equal((await cashier.get('/app/expenses')).status, 403);
  assert.equal((await cashier.post('/app/expenses', { amount: 1, category: 'other' })).status, 403);
});
