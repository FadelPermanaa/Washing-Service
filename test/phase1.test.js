const test = require('node:test');
const assert = require('node:assert/strict');
const { bootApp, Client, flashText } = require('./helpers');

let env;
let admin;
test.before(async () => {
  env = await bootApp();
  admin = new Client(env.base);
  await admin.login();
  await admin.get('/app/users?lang=en');
  await admin.post('/app/users', { name: 'Joko', username: 'joko', password: 'secret1', role: 'washer', commission_type: 'fixed', commission_value: 8000 });
  await admin.post('/app/users', { name: 'Rina', username: 'rina', password: 'secret1', role: 'washer', commission_type: 'percent', commission_value: 10 });
});
test.after(async () => { await env.close(); });

const userId = (username) => env.db.prepare('SELECT id FROM users WHERE username = ?').get(username).id;

async function newWash(plate, packageId = 2) {
  await admin.get('/app/transactions/new');
  await admin.post('/app/transactions', { plate, vehicle_type_id: 3, package_id: packageId });
  return env.db.prepare('SELECT * FROM transactions ORDER BY id DESC LIMIT 1').get();
}

test('washer accounts store their commission settings', () => {
  const joko = env.db.prepare("SELECT role, commission_type, commission_value FROM users WHERE username = 'joko'").get();
  assert.deepEqual({ ...joko }, { role: 'washer', commission_type: 'fixed', commission_value: 8000 });
});

test('percent commission above 100 is rejected', async () => {
  await admin.get('/app/users');
  const r = await admin.postAndFollow('/app/users', { name: 'X', username: 'xx1', password: 'secret1', role: 'washer', commission_type: 'percent', commission_value: 150 });
  assert.equal(flashText(r.text).type, 'error');
  assert.equal(env.db.prepare("SELECT COUNT(*) AS n FROM users WHERE username = 'xx1'").get().n, 0);
});

test('starting a wash assigns washer and bay and copies the checklist', async () => {
  const tx = await newWash('B 1 AA');
  await admin.get('/app/queue');
  await admin.post(`/app/transactions/${tx.id}/status`, { action: 'start', washer_id: userId('joko'), bay_id: 1 });
  const row = env.db.prepare('SELECT status, washer_id, bay_id FROM transactions WHERE id = ?').get(tx.id);
  assert.deepEqual({ ...row }, { status: 'washing', washer_id: userId('joko'), bay_id: 1 });
  const checks = env.db.prepare('SELECT COUNT(*) AS n FROM transaction_checks WHERE transaction_id = ?').get(tx.id).n;
  const template = env.db.prepare('SELECT COUNT(*) AS n FROM checklist_items WHERE package_id = 2').get().n;
  assert.ok(template > 0);
  assert.equal(checks, template);
});

test('a bay cannot hold two cars at once', async () => {
  const tx = await newWash('B 2 BB');
  await admin.get('/app/queue?lang=en');
  const r = await admin.postAndFollow(`/app/transactions/${tx.id}/status`, { action: 'start', washer_id: userId('rina'), bay_id: 1 });
  assert.match(flashText(r.text).text, /Bay 1 is still in use/);
  assert.equal(env.db.prepare('SELECT status FROM transactions WHERE id = ?').get(tx.id).status, 'waiting');
});

test('washers see only their own jobs and cannot use the cashier pages', async () => {
  const joko = new Client(env.base);
  await joko.login('joko', 'secret1');
  const home = await joko.get('/app');
  assert.equal(home.location, '/app/jobs');
  const jobs = await joko.get('/app/jobs');
  assert.equal(jobs.status, 200);
  assert.match(jobs.text, /B 1 AA/);
  assert.equal((await joko.get('/app/queue')).status, 403);
  assert.equal((await joko.get('/app/transactions/new')).status, 403);
  assert.equal((await joko.get('/app/prices')).status, 403);

  // Rina cannot open or tick Joko's job
  const rina = new Client(env.base);
  await rina.login('rina', 'secret1');
  const tx = env.db.prepare("SELECT t.id FROM transactions t JOIN vehicles v ON v.id = t.vehicle_id WHERE v.plate = 'B 1 AA'").get();
  assert.equal((await rina.get(`/app/jobs/${tx.id}`)).status, 404);
  const check = env.db.prepare('SELECT id FROM transaction_checks WHERE transaction_id = ? LIMIT 1').get(tx.id);
  await rina.get('/app/jobs');
  await rina.post(`/app/jobs/${tx.id}/checks/${check.id}`);
  assert.equal(env.db.prepare('SELECT done_at FROM transaction_checks WHERE id = ?').get(check.id).done_at, null);
});

test('washer ticks steps and finishes the job; fixed commission is recorded', async () => {
  const joko = new Client(env.base);
  await joko.login('joko', 'secret1');
  const tx = env.db.prepare("SELECT t.* FROM transactions t JOIN vehicles v ON v.id = t.vehicle_id WHERE v.plate = 'B 1 AA'").get();
  await joko.get(`/app/jobs/${tx.id}`);
  const checks = env.db.prepare('SELECT id FROM transaction_checks WHERE transaction_id = ?').all(tx.id);
  const r = await joko.request('POST', `/app/jobs/${tx.id}/checks/${checks[0].id}`, { form: {}, headers: { accept: 'application/json' } });
  assert.deepEqual(JSON.parse(r.text), { ok: true, done: true });
  const done = env.db.prepare('SELECT done_by FROM transaction_checks WHERE id = ?').get(checks[0].id);
  assert.equal(done.done_by, userId('joko'));

  await joko.post(`/app/jobs/${tx.id}/finish`);
  const after = env.db.prepare('SELECT status, commission FROM transactions WHERE id = ?').get(tx.id);
  assert.deepEqual({ ...after }, { status: 'done', commission: 8000 });

  // checklist is locked once done
  await joko.get(`/app/jobs/${tx.id}`);
  await joko.post(`/app/jobs/${tx.id}/checks/${checks[1].id}`);
  assert.equal(env.db.prepare('SELECT done_at FROM transaction_checks WHERE id = ?').get(checks[1].id).done_at, null);
});

test('percent commission is a share of the total', async () => {
  const tx = await newWash('B 3 CC');
  await admin.get('/app/queue');
  await admin.post(`/app/transactions/${tx.id}/status`, { action: 'start', washer_id: userId('rina'), bay_id: 1 });
  await admin.post(`/app/transactions/${tx.id}/status`, { action: 'finish' });
  const row = env.db.prepare('SELECT total, commission FROM transactions WHERE id = ?').get(tx.id);
  assert.equal(row.commission, Math.round(row.total * 0.1));
});

test('monthly report lists washer performance', async () => {
  const r = await admin.get('/app/reports?lang=en');
  assert.match(r.text, /Washer performance/);
  assert.match(r.text, /Joko/);
  assert.match(r.text, /Rp 8\.000/);
});

test('admin edits a package checklist', async () => {
  await admin.get('/app/checklists/1');
  const before = env.db.prepare('SELECT id, label FROM checklist_items WHERE package_id = 1 ORDER BY sort_order').all();
  await admin.post('/app/checklists/1', { label: 'Check tire pressure', label_id: 'Cek tekanan ban' });
  const added = env.db.prepare('SELECT * FROM checklist_items WHERE package_id = 1 ORDER BY sort_order DESC LIMIT 1').get();
  assert.equal(added.label_id, 'Cek tekanan ban');
  await admin.post(`/app/checklists/1/${added.id}`, { op: 'up' });
  const order = env.db.prepare('SELECT id FROM checklist_items WHERE package_id = 1 ORDER BY sort_order').all().map((r) => r.id);
  assert.equal(order[order.length - 2], added.id);
  await admin.post(`/app/checklists/1/${added.id}`, { op: 'delete' });
  assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM checklist_items WHERE package_id = 1').get().n, before.length);
});

test('a bay in use cannot be hidden', async () => {
  const tx = await newWash('B 4 DD');
  await admin.get('/app/queue');
  await admin.post(`/app/transactions/${tx.id}/status`, { action: 'start', bay_id: 2 });
  await admin.get('/app/settings');
  await admin.post('/app/bays/2/toggle');
  assert.equal(env.db.prepare('SELECT active FROM bays WHERE id = 2').get().active, 1);
});
