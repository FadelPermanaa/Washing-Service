const express = require('express');
const { db, now, tx } = require('../db');
const { hashPassword } = require('../auth');
const svc = require('../services');
const { flash, action } = require('./util');

const router = express.Router();
const { UserError, toInt, clean } = svc;

// ---------- Price list ----------

router.get('/prices', (req, res) => {
  res.render('app/prices', { title: req.t('prices.title'), priceList: svc.getPriceList({ includeInactive: true }) });
});

router.post('/prices', action((req, res) => {
  const { types, packages } = svc.getPriceList({ includeInactive: true });
  const upsert = db.prepare(`INSERT INTO package_prices (package_id, vehicle_type_id, price) VALUES (?, ?, ?)
    ON CONFLICT (package_id, vehicle_type_id) DO UPDATE SET price = excluded.price`);
  const del = db.prepare('DELETE FROM package_prices WHERE package_id = ? AND vehicle_type_id = ?');
  tx(() => {
    for (const p of packages) {
      for (const t of types) {
        const raw = String(req.body[`price_${p.id}_${t.id}`] ?? '').trim();
        if (raw === '') del.run(p.id, t.id);
        else upsert.run(p.id, t.id, Math.max(0, toInt(raw)));
      }
    }
  });
  flash(req, 'success', 'flash.pricesSaved');
  res.redirect('/app/prices');
}, '/app/prices'));

const CATALOG = { 'vehicle-types': 'vehicle_types', packages: 'packages', addons: 'addons' };

function catalogTable(kind) {
  const table = CATALOG[kind];
  if (!table) throw new UserError('err.unknownCatalog');
  return table;
}

router.post('/catalog/:kind', action((req, res) => {
  const table = catalogTable(req.params.kind);
  const name = clean(req.body.name, 60);
  const nameId = clean(req.body.name_id, 60);
  if (!name) throw new UserError('err.nameRequired');
  if (db.prepare(`SELECT 1 FROM ${table} WHERE name = ?`).get(name)) throw new UserError('err.exists', { name });
  if (table === 'addons') {
    db.prepare('INSERT INTO addons (name, name_id, price) VALUES (?, ?, ?)').run(name, nameId, Math.max(0, toInt(req.body.price)));
  } else if (table === 'packages') {
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

router.post('/catalog/:kind/:id/toggle', action((req, res) => {
  const table = catalogTable(req.params.kind);
  db.prepare(`UPDATE ${table} SET active = 1 - active WHERE id = ?`).run(toInt(req.params.id));
  res.redirect('/app/prices');
}, '/app/prices'));

router.post('/catalog/:kind/:id/names', action((req, res) => {
  const table = catalogTable(req.params.kind);
  const id = toInt(req.params.id);
  const name = clean(req.body.name, 60);
  if (!name) throw new UserError('err.nameRequired');
  if (db.prepare(`SELECT 1 FROM ${table} WHERE name = ? AND id != ?`).get(name, id)) throw new UserError('err.exists', { name });
  if (table === 'packages') {
    db.prepare('UPDATE packages SET name = ?, name_id = ?, description = ?, description_id = ? WHERE id = ?')
      .run(name, clean(req.body.name_id, 60), clean(req.body.description, 160), clean(req.body.description_id, 160), id);
  } else {
    db.prepare(`UPDATE ${table} SET name = ?, name_id = ? WHERE id = ?`).run(name, clean(req.body.name_id, 60), id);
  }
  flash(req, 'success', 'flash.saved');
  res.redirect('/app/prices');
}, '/app/prices'));

router.post('/catalog/addons/:id/price', action((req, res) => {
  db.prepare('UPDATE addons SET price = ? WHERE id = ?').run(Math.max(0, toInt(req.body.price)), toInt(req.params.id));
  flash(req, 'success', 'flash.addonPrice');
  res.redirect('/app/prices');
}, '/app/prices'));

// ---------- Staff accounts ----------

router.get('/users', (req, res) => {
  const users = db.prepare('SELECT id, name, username, role, active, created_at FROM users ORDER BY id').all();
  res.render('app/users', { title: req.t('users.title'), users });
});

router.post('/users', action((req, res) => {
  const name = clean(req.body.name, 60);
  const username = String(req.body.username || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const role = ['admin', 'cashier'].includes(req.body.role) ? req.body.role : 'cashier';
  if (!name || !/^[a-z0-9._-]{3,30}$/.test(username)) throw new UserError('err.userInvalid');
  if (password.length < 6) throw new UserError('err.passwordShort');
  if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) throw new UserError('err.usernameTaken');
  db.prepare('INSERT INTO users (name, username, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(name, username, hashPassword(password), role, now());
  flash(req, 'success', 'flash.userCreated', { u: username });
  res.redirect('/app/users');
}, '/app/users'));

router.post('/users/:id/toggle', action((req, res) => {
  const id = toInt(req.params.id);
  if (id === req.session.user.id) throw new UserError('err.selfDisable');
  db.prepare('UPDATE users SET active = 1 - active WHERE id = ?').run(id);
  res.redirect('/app/users');
}, '/app/users'));

router.post('/users/:id/password', action((req, res) => {
  const password = String(req.body.password || '');
  if (password.length < 6) throw new UserError('err.passwordShort');
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(password), toInt(req.params.id));
  flash(req, 'success', 'flash.passwordUpdated');
  res.redirect('/app/users');
}, '/app/users'));

module.exports = router;
