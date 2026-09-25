const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const session = require('express-session');
const { db, now, today, tx } = require('./db');
const { hashPassword, verifyPassword, requireLogin, requireAdmin } = require('./auth');
const svc = require('./services');
const { i18nMiddleware } = require('./i18n');

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));
app.disable('x-powered-by');

app.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: '1h' }));
app.use(express.urlencoded({ extended: true }));
app.use(i18nMiddleware);
app.use(session({
  name: 'wsh.sid',
  secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', maxAge: 12 * 60 * 60 * 1000 },
}));

const BUSINESS_NAME = process.env.BUSINESS_NAME || 'Sparkle Wash';
const rupiah = (n) => `Rp ${Number(n || 0).toLocaleString('id-ID')}`;

app.use((req, res, next) => {
  res.locals.user = req.session.user || null;
  const f = req.session.flash;
  res.locals.flash = f ? { type: f.type, message: req.t(f.key, f.params) } : null;
  delete req.session.flash;
  res.locals.path = req.path;
  res.locals.businessName = BUSINESS_NAME;
  res.locals.rupiah = rupiah;
  res.locals.time = (ts) => (ts ? ts.slice(11, 16) : '—');
  next();
});

function flash(req, type, key, params = {}) {
  req.session.flash = { type, key, params };
}

function sameOriginReferer(req) {
  try {
    const url = new URL(req.get('Referer'));
    return url.host === req.get('host') ? url.pathname + url.search : null;
  } catch {
    return null;
  }
}

/** Wrap a POST handler: UserErrors become a flash message + redirect back. */
function action(fn, fallback = '/app') {
  return (req, res, next) => {
    try {
      fn(req, res);
    } catch (err) {
      if (!(err instanceof svc.UserError)) return next(err);
      flash(req, 'error', err.key, err.params);
      res.redirect(sameOriginReferer(req) || fallback);
    }
  };
}

// ---------- Public ----------

app.get('/', (req, res) => {
  res.render('landing', { title: BUSINESS_NAME, priceList: svc.getPriceList() });
});

app.get('/status', (req, res) => {
  const plate = svc.normalizePlate(req.query.plate);
  res.render('status', { title: req.t('status.title'), plate, results: plate ? svc.publicStatus(plate) : null });
});

app.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/app');
  res.render('login', { title: req.t('login.title'), next: req.query.next || '/app', error: null });
});

app.post('/login', (req, res, next) => {
  const u = db.prepare('SELECT * FROM users WHERE username = ? AND active = 1').get(String(req.body.username || '').trim().toLowerCase());
  const dest = String(req.body.next || '/app');
  const safeDest = dest.startsWith('/app') ? dest : '/app';
  if (!u || !verifyPassword(String(req.body.password || ''), u.password_hash)) {
    return res.status(401).render('login', { title: req.t('login.title'), next: safeDest, error: req.t('login.error') });
  }
  req.session.regenerate((err) => {
    if (err) return next(err);
    req.session.user = { id: u.id, name: u.name, username: u.username, role: u.role };
    res.redirect(safeDest);
  });
});

app.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

// ---------- Staff app ----------

const staff = express.Router();
staff.use(requireLogin);

staff.get('/', (req, res) => {
  res.render('app/dashboard', {
    title: req.t('dash.title'),
    stats: svc.dashboardStats(),
    queue: svc.queue(),
    recent: svc.listTransactions({ date: today() }).slice(0, 8),
  });
});

staff.get('/queue', (req, res) => {
  res.render('app/queue', { title: req.t('queue.title'), queue: svc.queue(), methods: svc.PAYMENT_METHODS });
});

staff.get('/transactions/new', (req, res) => {
  res.render('app/new', {
    title: req.t('new.title'),
    priceList: svc.getPriceList(),
    methods: svc.PAYMENT_METHODS,
    plate: svc.normalizePlate(req.query.plate),
  });
});

staff.post('/transactions', action((req, res) => {
  const id = svc.createTransaction(req.body, req.session.user.id);
  flash(req, 'success', 'flash.added');
  res.redirect(req.body.print === '1' ? `/app/transactions/${id}?print=1` : '/app/queue');
}, '/app/transactions/new'));

staff.get('/api/vehicle', (req, res) => {
  res.json({ vehicle: svc.findVehicleByPlate(req.query.plate) });
});

staff.get('/transactions', (req, res) => {
  const filters = {
    date: /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : (req.query.date === 'all' ? '' : today()),
    status: ['waiting', 'washing', 'done', 'cancelled', 'unpaid'].includes(req.query.status) ? req.query.status : '',
    q: String(req.query.q || '').slice(0, 50),
  };
  const rows = svc.listTransactions(filters);
  res.render('app/transactions', { title: req.t('tx.title'), rows, filters });
});

staff.get('/transactions/:id', (req, res) => {
  const t = svc.getTransaction(svc.toInt(req.params.id));
  if (!t) return res.status(404).render('error', { title: req.t('error.notFoundTitle'), message: req.t('err.txNotFound') });
  res.render('app/transaction', { title: t.code, tx: t, methods: svc.PAYMENT_METHODS, autoPrint: req.query.print === '1' });
});

staff.post('/transactions/:id/status', action((req, res) => {
  svc.changeStatus(svc.toInt(req.params.id), String(req.body.action));
  flash(req, 'success', `flash.${req.body.action}`);
  res.redirect(req.body.back === 'detail' ? `/app/transactions/${req.params.id}` : '/app/queue');
}, '/app/queue'));

staff.post('/transactions/:id/pay', action((req, res) => {
  svc.markPaid(svc.toInt(req.params.id), String(req.body.method));
  flash(req, 'success', 'flash.paid');
  res.redirect(req.body.back === 'detail' ? `/app/transactions/${req.params.id}` : '/app/queue');
}, '/app/queue'));

staff.get('/vehicles', (req, res) => {
  const q = String(req.query.q || '').slice(0, 50);
  res.render('app/vehicles', { title: req.t('veh.title'), rows: svc.listVehicles(q), q });
});

staff.get('/reports', (req, res) => {
  res.render('app/reports', { title: req.t('rep.title'), report: svc.monthlyReport(req.query.month) });
});

// ---------- Admin: price list ----------

staff.get('/prices', requireAdmin, (req, res) => {
  res.render('app/prices', { title: req.t('prices.title'), priceList: svc.getPriceList({ includeInactive: true }) });
});

staff.post('/prices', requireAdmin, action((req, res) => {
  const { types, packages } = svc.getPriceList({ includeInactive: true });
  const upsert = db.prepare(`INSERT INTO package_prices (package_id, vehicle_type_id, price) VALUES (?, ?, ?)
    ON CONFLICT (package_id, vehicle_type_id) DO UPDATE SET price = excluded.price`);
  const del = db.prepare('DELETE FROM package_prices WHERE package_id = ? AND vehicle_type_id = ?');
  tx(() => {
    for (const p of packages) {
      for (const t of types) {
        const raw = String(req.body[`price_${p.id}_${t.id}`] ?? '').trim();
        if (raw === '') del.run(p.id, t.id);
        else upsert.run(p.id, t.id, Math.max(0, svc.toInt(raw)));
      }
    }
  });
  flash(req, 'success', 'flash.pricesSaved');
  res.redirect('/app/prices');
}, '/app/prices'));

const catalog = {
  'vehicle-types': { table: 'vehicle_types' },
  packages: { table: 'packages' },
  addons: { table: 'addons' },
};

const clean = (v, max) => String(v ?? '').trim().slice(0, max) || null;

staff.post('/catalog/:kind', requireAdmin, action((req, res) => {
  const c = catalog[req.params.kind];
  if (!c) throw new svc.UserError('err.unknownCatalog');
  const name = clean(req.body.name, 60);
  const nameId = clean(req.body.name_id, 60);
  if (!name) throw new svc.UserError('err.nameRequired');
  if (db.prepare(`SELECT 1 FROM ${c.table} WHERE name = ?`).get(name)) throw new svc.UserError('err.exists', { name });
  if (c.table === 'addons') {
    db.prepare('INSERT INTO addons (name, name_id, price) VALUES (?, ?, ?)').run(name, nameId, Math.max(0, svc.toInt(req.body.price)));
  } else if (c.table === 'packages') {
    const order = db.prepare('SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM packages').get().n;
    db.prepare('INSERT INTO packages (name, name_id, description, description_id, sort_order) VALUES (?, ?, ?, ?, ?)')
      .run(name, nameId, clean(req.body.description, 160), clean(req.body.description_id, 160), order);
  } else {
    const order = db.prepare('SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM vehicle_types').get().n;
    db.prepare('INSERT INTO vehicle_types (name, name_id, sort_order) VALUES (?, ?, ?)').run(name, nameId, order);
  }
  flash(req, 'success', 'flash.catalogAdded', { label: { key: `cat.${req.params.kind}` } });
  res.redirect('/app/prices');
}, '/app/prices'));

staff.post('/catalog/:kind/:id/toggle', requireAdmin, action((req, res) => {
  const c = catalog[req.params.kind];
  if (!c) throw new svc.UserError('err.unknownCatalog');
  db.prepare(`UPDATE ${c.table} SET active = 1 - active WHERE id = ?`).run(svc.toInt(req.params.id));
  res.redirect('/app/prices');
}, '/app/prices'));

staff.post('/catalog/:kind/:id/names', requireAdmin, action((req, res) => {
  const c = catalog[req.params.kind];
  if (!c) throw new svc.UserError('err.unknownCatalog');
  const id = svc.toInt(req.params.id);
  const name = clean(req.body.name, 60);
  if (!name) throw new svc.UserError('err.nameRequired');
  if (db.prepare(`SELECT 1 FROM ${c.table} WHERE name = ? AND id != ?`).get(name, id)) throw new svc.UserError('err.exists', { name });
  if (c.table === 'packages') {
    db.prepare('UPDATE packages SET name = ?, name_id = ?, description = ?, description_id = ? WHERE id = ?')
      .run(name, clean(req.body.name_id, 60), clean(req.body.description, 160), clean(req.body.description_id, 160), id);
  } else {
    db.prepare(`UPDATE ${c.table} SET name = ?, name_id = ? WHERE id = ?`).run(name, clean(req.body.name_id, 60), id);
  }
  flash(req, 'success', 'flash.saved');
  res.redirect('/app/prices');
}, '/app/prices'));

staff.post('/catalog/addons/:id/price', requireAdmin, action((req, res) => {
  db.prepare('UPDATE addons SET price = ? WHERE id = ?').run(Math.max(0, svc.toInt(req.body.price)), svc.toInt(req.params.id));
  flash(req, 'success', 'flash.addonPrice');
  res.redirect('/app/prices');
}, '/app/prices'));

// ---------- Admin: staff accounts ----------

staff.get('/users', requireAdmin, (req, res) => {
  const users = db.prepare('SELECT id, name, username, role, active, created_at FROM users ORDER BY id').all();
  res.render('app/users', { title: req.t('users.title'), users });
});

staff.post('/users', requireAdmin, action((req, res) => {
  const name = String(req.body.name || '').trim();
  const username = String(req.body.username || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const role = req.body.role === 'admin' ? 'admin' : 'cashier';
  if (!name || !/^[a-z0-9._-]{3,30}$/.test(username)) throw new svc.UserError('err.userInvalid');
  if (password.length < 6) throw new svc.UserError('err.passwordShort');
  if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) throw new svc.UserError('err.usernameTaken');
  db.prepare('INSERT INTO users (name, username, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(name, username, hashPassword(password), role, now());
  flash(req, 'success', 'flash.userCreated', { u: username });
  res.redirect('/app/users');
}, '/app/users'));

staff.post('/users/:id/toggle', requireAdmin, action((req, res) => {
  const id = svc.toInt(req.params.id);
  if (id === req.session.user.id) throw new svc.UserError('err.selfDisable');
  db.prepare('UPDATE users SET active = 1 - active WHERE id = ?').run(id);
  res.redirect('/app/users');
}, '/app/users'));

staff.post('/users/:id/password', requireAdmin, action((req, res) => {
  const password = String(req.body.password || '');
  if (password.length < 6) throw new svc.UserError('err.passwordShort');
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(password), svc.toInt(req.params.id));
  flash(req, 'success', 'flash.passwordUpdated');
  res.redirect('/app/users');
}, '/app/users'));

app.use('/app', staff);

app.use((req, res) => {
  res.status(404).render('error', { title: req.t('error.notFoundTitle'), message: req.t('error.pageMissing') });
});

app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  console.error(err);
  const t = req.t || ((k) => k);
  res.status(500).render('error', { title: t('error.serverTitle'), message: t('error.server') });
});

module.exports = app;
