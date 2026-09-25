// WhatsApp messages sent automatically through a gateway (a fake Fonnte-compatible server here).
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const received = [];
let failNext = false;
const gateway = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    received.push({ auth: req.headers.authorization, body: JSON.parse(body) });
    res.setHeader('content-type', 'application/json');
    if (failNext) { failNext = false; res.end(JSON.stringify({ status: false, reason: 'device offline' })); return; }
    res.end(JSON.stringify({ status: true }));
  });
});

let env;
let svc;
test.before(async () => {
  await new Promise((r) => gateway.listen(0, r));
  process.env.WHATSAPP_TOKEN = 'test-token';
  process.env.WHATSAPP_API_URL = `http://127.0.0.1:${gateway.address().port}/send`;
  process.env.PUBLIC_URL = 'https://cuci.example.com';
  const { bootApp } = require('./helpers');
  env = await bootApp();
  svc = require('../src/services');
});
test.after(async () => { await env.close(); gateway.close(); });

const waitFor = async (fn) => {
  for (let i = 0; i < 50; i++) { if (fn()) return; await new Promise((r) => setTimeout(r, 20)); }
  throw new Error('timeout');
};

test('messages are sent to the gateway with the token and full link', async () => {
  const { Client } = require('./helpers');
  const admin = new Client(env.base);
  await admin.login();
  await admin.get('/app/transactions/new');
  await admin.post('/app/transactions', { plate: 'B 1 GW', vehicle_type_id: 2, package_id: 1, customer_name: 'Tono', customer_phone: '081212121212' });
  await waitFor(() => received.length === 1);
  assert.equal(received[0].auth, 'test-token');
  assert.equal(received[0].body.target, '6281212121212');
  assert.match(received[0].body.message, /https:\/\/cuci\.example\.com\/t\/[\w-]{16}/);
  await waitFor(() => env.db.prepare("SELECT status FROM notifications ORDER BY id DESC LIMIT 1").get().status === 'sent');
});

test('a failed send is recorded and can be retried', async () => {
  failNext = true;
  const tx = env.db.prepare('SELECT id FROM transactions ORDER BY id DESC LIMIT 1').get();
  env.db.prepare("UPDATE transactions SET status = 'washing' WHERE id = ?").run(tx.id);
  svc.finishWash(tx.id);
  await waitFor(() => env.db.prepare("SELECT status FROM notifications WHERE kind = 'tx_ready'").get()?.status === 'failed');
  const n = env.db.prepare("SELECT * FROM notifications WHERE kind = 'tx_ready'").get();
  assert.equal(n.error, 'device offline');
  svc.notifications.retry(n.id);
  await waitFor(() => env.db.prepare('SELECT status FROM notifications WHERE id = ?').get(n.id).status === 'sent');
});
