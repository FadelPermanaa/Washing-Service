// Test helpers: boot the app on a throw-away database and talk to it over HTTP like a browser.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function bootApp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wsh-test-'));
  process.env.DATA_DIR = dir;
  process.env.DB_PATH = path.join(dir, 'test.db');
  process.env.TZ = 'Asia/Jakarta';
  process.env.DISABLE_RATE_LIMIT = process.env.DISABLE_RATE_LIMIT ?? '1';
  process.env.SESSION_SECRET = 'test-secret';
  const app = require('../src/app');
  const { db } = require('../src/db');
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const base = `http://127.0.0.1:${server.address().port}`;
      resolve({
        base, db, dir,
        close: () => new Promise((r) => { server.close(r); server.closeAllConnections?.(); }),
      });
    });
  });
}

/** A minimal browser: keeps cookies, remembers the last CSRF token it saw, never follows redirects. */
class Client {
  constructor(base) {
    this.base = base;
    this.cookies = new Map();
    this.csrf = null;
  }

  cookieHeader() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  store(res) {
    for (const c of res.headers.getSetCookie?.() || []) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      this.cookies.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
    }
  }

  async request(method, url, { form, json, headers = {}, body } = {}) {
    const h = { cookie: this.cookieHeader(), ...headers };
    let payload = body;
    if (form) {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(form)) {
        for (const item of [].concat(v)) params.append(k, String(item));
      }
      if (!('_csrf' in form) && this.csrf) params.append('_csrf', this.csrf);
      payload = params;
    } else if (json) {
      h['content-type'] = 'application/json';
      if (this.csrf) h['x-csrf-token'] = this.csrf;
      payload = JSON.stringify(json);
    }
    const res = await fetch(this.base + url, { method, headers: h, body: payload, redirect: 'manual' });
    this.store(res);
    const text = await res.text();
    const m = text.match(/name="_csrf" value="([^"]+)"/);
    if (m) this.csrf = m[1];
    return { status: res.status, location: res.headers.get('location'), text, headers: res.headers };
  }

  get(url) { return this.request('GET', url); }

  post(url, form = {}) { return this.request('POST', url, { form }); }

  /** Follow a redirect after a POST and return the page (so its flash message can be read). */
  async postAndFollow(url, form = {}) {
    const r = await this.post(url, form);
    if (r.status !== 302) return r;
    return this.get(new URL(r.location, this.base).pathname + new URL(r.location, this.base).search);
  }

  async login(username = 'admin', password = 'admin123') {
    await this.get('/login');
    const r = await this.post('/login', { username, password });
    if (r.status !== 302) throw new Error(`login failed for ${username}: ${r.status}`);
    await this.get('/app/queue').catch(() => {});
    return r;
  }
}

/** Text of the flash message on a page, or null. */
function flashText(html) {
  const m = html.match(/class="flash flash-(\w+)"[^>]*>([^<]*)/);
  return m ? { type: m[1], text: m[2].replace(/&#34;/g, '"').trim() } : null;
}

module.exports = { bootApp, Client, flashText };
