const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const session = require('express-session');
const { db, now, today, tx } = require('./db');
const { hashPassword, verifyPassword, requireLogin, requireAdmin } = require('./auth');
const svc = require('./services');

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));
app.disable('x-powered-by');

app.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: '1h' }));
app.use(express.urlencoded({ extended: true }));
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
  res.locals.flash = req.session.flash || null;
  delete req.session.flash;
  res.locals.path = req.path;
  res.locals.businessName = BUSINESS_NAME;
  res.locals.rupiah = rupiah;
  res.locals.time = (ts) => (ts ? ts.slice(11, 16) : '—');
  next();
});

function flash(req, type, message) {
  req.session.flash = { type, message };
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
      flash(req, 'error', err.message);
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
  res.render('status', { title: 'Wash status', plate, results: plate ? svc.publicStatus(plate) : null });
});

app.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/app');
  res.render('login', { title: 'Staff login', next: req.query.next || '/app', error: null });
});

app.post('/login', (req, res, next) => {
  const u = db.prepare('SELECT * FROM users WHERE username = ? AND active = 1').get(String(req.body.username || '').trim().toLowerCase());
  const dest = String(req.body.next || '/app');
  const safeDest = dest.startsWith('/app') ? dest : '/app';
  if (!u || !verifyPassword(String(req.body.password || ''), u.password_hash)) {
    return res.status(401).render('login', { title: 'Staff login', next: safeDest, error: 'Wrong username or password.' });
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
    title: 'Dashboard',
    stats: svc.dashboardStats(),
    queue: svc.queue(),
    recent: svc.listTransactions({ date: today() }).slice(0, 8),
  });
});

staff.get('/queue', (req, res) => {
  res.render('app/queue', { title: 'Queue', queue: svc.queue(), methods: svc.PAYMENT_METHODS });
});

staff.get('/transactions/new', (req, res) => {
  res.render('app/new', {
    title: 'New wash',
    priceList: svc.getPriceList(),
    methods: svc.PAYMENT_METHODS,
    plate: svc.normalizePlate(req.query.plate),
  });
});

staff.post('/transactions', action((req, res) => {
  const id = svc.createTransaction(req.body, req.session.user.id);
  flash(req, 'success', 'Wash added to the queue.');
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
  res.render('app/transactions', { title: 'Transactions', rows, filters });
});

staff.get('/transactions/:id', (req, res) => {
  const t = svc.getTransaction(svc.toInt(req.params.id));
  if (!t) return res.status(404).render('error', { title: 'Not found', message: 'Transaction not found.' });
  res.render('app/transaction', { title: t.code, t, methods: svc.PAYMENT_METHODS, autoPrint: req.query.print === '1' });
});

staff.post('/transactions/:id/status', action((req, res) => {
  svc.changeStatus(svc.toInt(req.params.id), String(req.body.action));
  const labels = { start: 'Washing started.', finish: 'Wash finished.', cancel: 'Transaction cancelled.' };
  flash(req, 'success', labels[req.body.action]);
  res.redirect(req.body.back === 'detail' ? `/app/transactions/${req.params.id}` : '/app/queue');
}, '/app/queue'));

staff.post('/transactions/:id/pay', action((req, res) => {
  svc.markPaid(svc.toInt(req.params.id), String(req.body.method));
  flash(req, 'success', 'Payment recorded.');
  res.redirect(req.body.back === 'detail' ? `/app/transactions/${req.params.id}` : '/app/queue');
}, '/app/queue'));

staff.get('/vehicles', (req, res) => {
  const q = String(req.query.q || '').slice(0, 50);
  res.render('app/vehicles', { title: 'Vehicles', rows: svc.listVehicles(q), q });
});

staff.get('/reports', (req, res) => {
  res.render('app/reports', { title: 'Reports', report: svc.monthlyReport(req.query.month) });
});

// ---------- Admin: price list ----------

staff.get('/prices', requireAdmin, (req, res) => {
  res.render('app/prices', { title: 'Price list', priceList: svc.getPriceList({ includeInactive: true }) });
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
  flash(req, 'success', 'Prices saved.');
  res.redirect('/app/prices');
}, '/app/prices'));

const catalog = {
  'vehicle-types': { table: 'vehicle_types', label: 'Vehicle type' },
  packages: { table: 'packages', label: 'Package' },
  addons: { table: 'addons', label: 'Add-on' },
};

staff.post('/catalog/:kind', requireAdmin, action((req, res) => {
  const c = catalog[req.params.kind];
  if (!c) throw new svc.UserError('Unknown catalog.');
  const name = String(req.body.name || '').trim();
  if (!name) throw new svc.UserError(`${c.label} name is required.`);
  if (db.prepare(`SELECT 1 FROM ${c.table} WHERE name = ?`).get(name)) throw new svc.UserError(`${c.label} "${name}" already exists.`);
  if (c.table === 'addons') {
    db.prepare('INSERT INTO addons (name, price) VALUES (?, ?)').run(name, Math.max(0, svc.toInt(req.body.price)));
  } else if (c.table === 'packages') {
    const order = db.prepare('SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM packages').get().n;
    db.prepare('INSERT INTO packages (name, description, sort_order) VALUES (?, ?, ?)').run(name, String(req.body.description || '').trim() || null, order);
  } else {
    const order = db.prepare('SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM vehicle_types').get().n;
    db.prepare('INSERT INTO vehicle_types (name, sort_order) VALUES (?, ?)').run(name, order);
  }
  flash(req, 'success', `${c.label} added.`);
  res.redirect('/app/prices');
}, '/app/prices'));

staff.post('/catalog/:kind/:id/toggle', requireAdmin, action((req, res) => {
  const c = catalog[req.params.kind];
  if (!c) throw new svc.UserError('Unknown catalog.');
  db.prepare(`UPDATE ${c.table} SET active = 1 - active WHERE id = ?`).run(svc.toInt(req.params.id));
  res.redirect('/app/prices');
}, '/app/prices'));

staff.post('/catalog/addons/:id/price', requireAdmin, action((req, res) => {
  db.prepare('UPDATE addons SET price = ? WHERE id = ?').run(Math.max(0, svc.toInt(req.body.price)), svc.toInt(req.params.id));
  flash(req, 'success', 'Add-on price saved.');
  res.redirect('/app/prices');
}, '/app/prices'));

// ---------- Admin: staff accounts ----------

staff.get('/users', requireAdmin, (req, res) => {
  const users = db.prepare('SELECT id, name, username, role, active, created_at FROM users ORDER BY id').all();
  res.render('app/users', { title: 'Staff', users });
});

staff.post('/users', requireAdmin, action((req, res) => {
  const name = String(req.body.name || '').trim();
  const username = String(req.body.username || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const role = req.body.role === 'admin' ? 'admin' : 'cashier';
  if (!name || !/^[a-z0-9._-]{3,30}$/.test(username)) throw new svc.UserError('Name is required; username must be 3–30 letters, numbers, . _ or -.');
  if (password.length < 6) throw new svc.UserError('Password must be at least 6 characters.');
  if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) throw new svc.UserError('Username already taken.');
  db.prepare('INSERT INTO users (name, username, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(name, username, hashPassword(password), role, now());
  flash(req, 'success', `Account "${username}" created.`);
  res.redirect('/app/users');
}, '/app/users'));

staff.post('/users/:id/toggle', requireAdmin, action((req, res) => {
  const id = svc.toInt(req.params.id);
  if (id === req.session.user.id) throw new svc.UserError('You cannot deactivate your own account.');
  db.prepare('UPDATE users SET active = 1 - active WHERE id = ?').run(id);
  res.redirect('/app/users');
}, '/app/users'));

staff.post('/users/:id/password', requireAdmin, action((req, res) => {
  const password = String(req.body.password || '');
  if (password.length < 6) throw new svc.UserError('Password must be at least 6 characters.');
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(password), svc.toInt(req.params.id));
  flash(req, 'success', 'Password updated.');
  res.redirect('/app/users');
}, '/app/users'));

app.use('/app', staff);

app.use((req, res) => {
  res.status(404).render('error', { title: 'Not found', message: 'That page does not exist.' });
});

app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  console.error(err);
  res.status(500).render('error', { title: 'Something went wrong', message: 'An unexpected error occurred. Please try again.' });
});

module.exports = app;
