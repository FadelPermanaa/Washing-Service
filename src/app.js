const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const session = require('express-session');
const { requireLogin, requireRole, requireAdmin } = require('./auth');
const { i18nMiddleware } = require('./i18n');
const { csrf } = require('./security');

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));
app.disable('x-powered-by');
if (process.env.TRUST_PROXY) app.set('trust proxy', process.env.TRUST_PROXY === 'true' ? true : process.env.TRUST_PROXY);

app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'SAMEORIGIN');
  res.set('Referrer-Policy', 'same-origin');
  next();
});
app.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: '1h' }));
app.use(express.urlencoded({ extended: true, limit: '200kb' }));
app.use(express.json({ limit: '100kb' }));
app.use(session({
  name: 'wsh.sid',
  secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: process.env.COOKIE_SECURE === '1', maxAge: 12 * 60 * 60 * 1000 },
}));
app.use(i18nMiddleware);

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
app.use(csrf());

app.use('/', require('./routes/public'));

const staff = express.Router();
staff.use(requireLogin);
// Washers land on their own job list.
staff.get('/', (req, res, next) => (req.session.user.role === 'washer' ? res.redirect('/app/jobs') : next()));
staff.use('/jobs', requireRole('washer', 'cashier'));
staff.use(require('./routes/jobs'));
staff.use(['/prices', '/catalog', '/users', '/settings', '/checklists', '/bays'], requireAdmin);
staff.use(require('./routes/admin'));
staff.use(requireRole('cashier'), require('./routes/staff'));
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
