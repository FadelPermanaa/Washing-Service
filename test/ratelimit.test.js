const test = require('node:test');
const assert = require('node:assert/strict');

process.env.DISABLE_RATE_LIMIT = '0';
const { bootApp, Client } = require('./helpers');

test('login is rate limited after 10 attempts', async () => {
  const env = await bootApp();
  try {
    const c = new Client(env.base);
    await c.get('/login');
    const statuses = [];
    for (let i = 0; i < 11; i++) statuses.push((await c.post('/login', { username: 'admin', password: 'wrong' })).status);
    assert.deepEqual(statuses.slice(0, 10), Array(10).fill(401));
    assert.equal(statuses[10], 429);
  } finally {
    await env.close();
  }
});
