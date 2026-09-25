const express = require('express');
const { db } = require('../db');
const { verifyPassword } = require('../auth');
const { rateLimit } = require('../security');
const svc = require('../services');

const router = express.Router();

router.get('/', (req, res) => {
  res.render('landing', { title: res.locals.businessName, priceList: svc.getPriceList() });
});

router.get('/status', (req, res) => {
  const plate = svc.normalizePlate(req.query.plate);
  res.render('status', { title: req.t('status.title'), plate, results: plate ? svc.publicStatus(plate) : null });
});

router.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/app');
  res.render('login', { title: req.t('login.title'), next: req.query.next || '/app', error: null });
});

router.post('/login', rateLimit({ name: 'login', max: 10, windowMs: 5 * 60 * 1000 }), (req, res, next) => {
  const u = db.prepare('SELECT * FROM users WHERE username = ? AND active = 1').get(String(req.body.username || '').trim().toLowerCase());
  const dest = String(req.body.next || '/app');
  const safeDest = /^\/app(\/|$|\?)/.test(dest) ? dest : '/app';
  if (!u || !verifyPassword(String(req.body.password || ''), u.password_hash)) {
    return res.status(401).render('login', { title: req.t('login.title'), next: safeDest, error: req.t('login.error') });
  }
  req.session.regenerate((err) => {
    if (err) return next(err);
    req.session.user = { id: u.id, name: u.name, username: u.username, role: u.role };
    res.redirect(safeDest);
  });
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

module.exports = router;
