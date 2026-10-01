const express = require('express');
const { db, now, today, tx } = require('../db');
const { hashPassword } = require('../auth');
const svc = require('../services');
const settings = require('../settings');
const { flash, action, log } = require('./util');

const router = express.Router();
const { UserError, toInt, clean } = svc;
const ROLES = ['admin', 'cashier', 'washer'];

function commissionInput(body) {
  const type = body.commission_type === 'percent' ? 'percent' : 'fixed';
  let value = Math.max(0, toInt(body.commission_value));
  if (type === 'percent' && value > 100) throw new UserError('err.percentRange');
  return { type, value };
}

// ---------- Price list ----------

router.get('/prices', (req, res) => {
  const checklistCounts = Object.fromEntries(db.prepare('SELECT package_id, COUNT(*) AS n FROM checklist_items GROUP BY package_id').all().map((r) => [r.package_id, r.n]));
  res.render('app/prices', { title: req.t('prices.title'), priceList: svc.getPriceList({ includeInactive: true }), checklistCounts });
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
  log(req, 'prices.update');
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
    db.prepare('INSERT INTO packages (name, name_id, description, description_id, sort_order, duration_min) VALUES (?, ?, ?, ?, ?, ?)')
      .run(name, nameId, clean(req.body.description, 160), clean(req.body.description_id, 160), order, Math.min(480, Math.max(10, toInt(req.body.duration_min, 30))));
  } else {
    const order = db.prepare('SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM vehicle_types').get().n;
    db.prepare('INSERT INTO vehicle_types (name, name_id, sort_order) VALUES (?, ?, ?)').run(name, nameId, order);
  }
  log(req, 'catalog.add', { entity: req.params.kind, detail: { name, name_id: nameId } });
  flash(req, 'success', 'flash.catalogAdded', { label: { key: `cat.${req.params.kind}` } });
  res.redirect('/app/prices');
}, '/app/prices'));

router.post('/catalog/:kind/:id/toggle', action((req, res) => {
  const table = catalogTable(req.params.kind);
  db.prepare(`UPDATE ${table} SET active = 1 - active WHERE id = ?`).run(toInt(req.params.id));
  log(req, 'catalog.toggle', { entity: req.params.kind, id: toInt(req.params.id) });
  res.redirect('/app/prices');
}, '/app/prices'));

router.post('/catalog/:kind/:id/names', action((req, res) => {
  const table = catalogTable(req.params.kind);
  const id = toInt(req.params.id);
  const name = clean(req.body.name, 60);
  if (!name) throw new UserError('err.nameRequired');
  if (db.prepare(`SELECT 1 FROM ${table} WHERE name = ? AND id != ?`).get(name, id)) throw new UserError('err.exists', { name });
  if (table === 'packages') {
    const duration = Math.min(8 * 60, Math.max(10, toInt(req.body.duration_min, 30)));
    db.prepare('UPDATE packages SET name = ?, name_id = ?, description = ?, description_id = ?, duration_min = ? WHERE id = ?')
      .run(name, clean(req.body.name_id, 60), clean(req.body.description, 160), clean(req.body.description_id, 160), duration, id);
  } else {
    db.prepare(`UPDATE ${table} SET name = ?, name_id = ? WHERE id = ?`).run(name, clean(req.body.name_id, 60), id);
  }
  log(req, 'catalog.rename', { entity: req.params.kind, id, detail: { name, name_id: req.body.name_id } });
  flash(req, 'success', 'flash.saved');
  res.redirect('/app/prices');
}, '/app/prices'));

router.post('/catalog/addons/:id/price', action((req, res) => {
  db.prepare('UPDATE addons SET price = ? WHERE id = ?').run(Math.max(0, toInt(req.body.price)), toInt(req.params.id));
  log(req, 'addon.price', { entity: 'addons', id: toInt(req.params.id), detail: { price: toInt(req.body.price) } });
  flash(req, 'success', 'flash.addonPrice');
  res.redirect('/app/prices');
}, '/app/prices'));

// ---------- Staff accounts ----------

router.get('/users', (req, res) => {
  const users = db.prepare(`SELECT id, name, username, role, phone, commission_type, commission_value, active, created_at
    FROM users ORDER BY active DESC, role, name`).all();
  res.render('app/users', { title: req.t('users.title'), users });
});

router.post('/users', action((req, res) => {
  const name = clean(req.body.name, 60);
  const username = String(req.body.username || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const role = ROLES.includes(req.body.role) ? req.body.role : 'cashier';
  if (!name || !/^[a-z0-9._-]{3,30}$/.test(username)) throw new UserError('err.userInvalid');
  if (password.length < 6) throw new UserError('err.passwordShort');
  if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) throw new UserError('err.usernameTaken');
  const { type, value } = commissionInput(req.body);
  db.prepare(`INSERT INTO users (name, username, password_hash, role, phone, commission_type, commission_value, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(name, username, hashPassword(password), role, svc.normalizePhone(req.body.phone) || null, type, value, now());
  log(req, 'user.create', { entity: 'users', detail: { username, role } });
  flash(req, 'success', 'flash.userCreated', { u: username });
  res.redirect('/app/users');
}, '/app/users'));

router.post('/users/:id/profile', action((req, res) => {
  const id = toInt(req.params.id);
  const name = clean(req.body.name, 60);
  if (!name) throw new UserError('err.nameRequired');
  const role = ROLES.includes(req.body.role) ? req.body.role : 'cashier';
  if (id === req.session.user.id && role !== 'admin') throw new UserError('err.selfDemote');
  const { type, value } = commissionInput(req.body);
  db.prepare('UPDATE users SET name = ?, role = ?, phone = ?, commission_type = ?, commission_value = ? WHERE id = ?')
    .run(name, role, svc.normalizePhone(req.body.phone) || null, type, value, id);
  log(req, 'user.update', { entity: 'users', id, detail: { name, role, commission: `${type}:${value}` } });
  flash(req, 'success', 'flash.saved');
  res.redirect('/app/users');
}, '/app/users'));

router.post('/users/:id/toggle', action((req, res) => {
  const id = toInt(req.params.id);
  if (id === req.session.user.id) throw new UserError('err.selfDisable');
  db.prepare('UPDATE users SET active = 1 - active WHERE id = ?').run(id);
  log(req, 'user.toggle', { entity: 'users', id });
  res.redirect('/app/users');
}, '/app/users'));

router.post('/users/:id/password', action((req, res) => {
  const password = String(req.body.password || '');
  if (password.length < 6) throw new UserError('err.passwordShort');
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(password), toInt(req.params.id));
  log(req, 'user.password', { entity: 'users', id: toInt(req.params.id) });
  flash(req, 'success', 'flash.passwordUpdated');
  res.redirect('/app/users');
}, '/app/users'));

// ---------- Settings: wash bays ----------

router.get('/settings', (req, res) => {
  res.render('app/settings', {
    title: req.t('settings.title'), bays: svc.listBays({ activeOnly: false }), s: settings.all(), gateway: svc.notifications.hasGateway(),
  });
});

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

router.post('/settings/booking', action((req, res) => {
  const b = req.body;
  if (!TIME.test(b.open_time || '') || !TIME.test(b.close_time || '') || b.open_time >= b.close_time) throw new UserError('err.hours');
  settings.set({
    booking_enabled: b.booking_enabled === '1' ? '1' : '0',
    booking_auto_confirm: b.booking_auto_confirm === '1' ? '1' : '0',
    open_time: b.open_time,
    close_time: b.close_time,
    closed_days: [].concat(b.closed_days || []).map((d) => toInt(d)).filter((d) => d >= 0 && d <= 6).join(','),
    slot_minutes: String(Math.min(120, Math.max(10, toInt(b.slot_minutes, 30)))),
    booking_days_ahead: String(Math.min(60, Math.max(1, toInt(b.booking_days_ahead, 14)))),
    booking_min_notice: String(Math.min(24 * 60, Math.max(0, toInt(b.booking_min_notice, 60)))),
  });
  log(req, 'settings.booking', { detail: { open: b.open_time, close: b.close_time, enabled: b.booking_enabled === '1' } });
  flash(req, 'success', 'flash.saved');
  res.redirect('/app/settings#booking');
}, '/app/settings'));

router.post('/settings/business', action((req, res) => {
  const publicUrl = String(req.body.public_url || '').trim().replace(/\/$/, '');
  if (publicUrl && !/^https?:\/\/[^\s/]+(\/[^\s]*)?$/.test(publicUrl)) throw new UserError('err.url');
  settings.set({
    business_phone: svc.normalizePhone(req.body.business_phone),
    business_address: clean(req.body.business_address, 200) || '',
    whatsapp_enabled: req.body.whatsapp_enabled === '1' ? '1' : '0',
    message_lang: req.body.message_lang === 'en' ? 'en' : 'id',
    public_url: publicUrl,
  });
  log(req, 'settings.business');
  flash(req, 'success', 'flash.saved');
  res.redirect('/app/settings#business');
}, '/app/settings'));

router.post('/bays', action((req, res) => {
  const name = clean(req.body.name, 40);
  if (!name) throw new UserError('err.nameRequired');
  if (db.prepare('SELECT 1 FROM bays WHERE name = ?').get(name)) throw new UserError('err.exists', { name });
  const order = db.prepare('SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM bays').get().n;
  db.prepare('INSERT INTO bays (name, sort_order) VALUES (?, ?)').run(name, order);
  log(req, 'bay.add', { entity: 'bays', detail: { name } });
  flash(req, 'success', 'flash.saved');
  res.redirect('/app/settings#bays');
}, '/app/settings'));

router.post('/bays/:id', action((req, res) => {
  const id = toInt(req.params.id);
  const name = clean(req.body.name, 40);
  if (!name) throw new UserError('err.nameRequired');
  if (db.prepare('SELECT 1 FROM bays WHERE name = ? AND id != ?').get(name, id)) throw new UserError('err.exists', { name });
  db.prepare('UPDATE bays SET name = ? WHERE id = ?').run(name, id);
  log(req, 'bay.rename', { entity: 'bays', id, detail: { name } });
  flash(req, 'success', 'flash.saved');
  res.redirect('/app/settings#bays');
}, '/app/settings'));

router.post('/bays/:id/toggle', action((req, res) => {
  const id = toInt(req.params.id);
  const busy = db.prepare("SELECT 1 FROM transactions WHERE bay_id = ? AND status = 'washing'").get(id);
  const bay = db.prepare('SELECT * FROM bays WHERE id = ?').get(id);
  if (bay?.active && busy) throw new UserError('err.bayInUse');
  db.prepare('UPDATE bays SET active = 1 - active WHERE id = ?').run(id);
  log(req, 'bay.toggle', { entity: 'bays', id });
  res.redirect('/app/settings#bays');
}, '/app/settings'));

// ---------- Checklists per package ----------

router.get('/checklists/:packageId', (req, res) => {
  const pkg = db.prepare('SELECT * FROM packages WHERE id = ?').get(toInt(req.params.packageId));
  if (!pkg) return res.redirect('/app/prices');
  res.render('app/checklist', { title: req.t('checklist.title'), pkg, items: svc.packageChecklist(pkg.id) });
});

router.post('/checklists/:packageId', action((req, res) => {
  const pid = toInt(req.params.packageId);
  svc.addChecklistItem(pid, { label: req.body.label, labelId: req.body.label_id });
  log(req, 'checklist.add', { entity: 'packages', id: pid, detail: { label: req.body.label } });
  res.redirect(`/app/checklists/${pid}`);
}, '/app/prices'));

router.post('/checklists/:packageId/:itemId', action((req, res) => {
  const pid = toInt(req.params.packageId);
  const itemId = toInt(req.params.itemId);
  if (req.body.op === 'delete') svc.deleteChecklistItem(pid, itemId);
  else if (req.body.op === 'up' || req.body.op === 'down') svc.moveChecklistItem(pid, itemId, req.body.op === 'up' ? -1 : 1);
  else svc.updateChecklistItem(pid, itemId, { label: req.body.label, labelId: req.body.label_id });
  log(req, `checklist.${['delete', 'up', 'down'].includes(req.body.op) ? req.body.op : 'edit'}`, { entity: 'packages', id: pid });
  res.redirect(`/app/checklists/${pid}`);
}, '/app/prices'));

// ---------- Promo codes ----------

router.get('/promos', (req, res) => {
  res.render('app/promos', { title: req.t('promo.title'), rows: svc.listPromos() });
});

router.post('/promos', action((req, res) => {
  const code = svc.createPromo(req.body);
  log(req, 'promo.create', { entity: 'promos', detail: { code, type: req.body.type, value: toInt(req.body.value) } });
  flash(req, 'success', 'flash.promoCreated', { code });
  res.redirect('/app/promos');
}, '/app/promos'));

router.post('/promos/:id/toggle', action((req, res) => {
  svc.togglePromo(toInt(req.params.id));
  log(req, 'promo.toggle', { entity: 'promos', id: toInt(req.params.id) });
  res.redirect('/app/promos');
}, '/app/promos'));

// ---------- Membership plans & cancelling memberships ----------

router.post('/membership-plans', action((req, res) => {
  svc.createPlan(req.body);
  log(req, 'plan.create', { entity: 'membership_plans', detail: { name: req.body.name, price: toInt(req.body.price), washes: toInt(req.body.washes) } });
  flash(req, 'success', 'flash.saved');
  res.redirect('/app/memberships#plans');
}, '/app/memberships'));

router.post('/membership-plans/:id/toggle', action((req, res) => {
  svc.togglePlan(toInt(req.params.id));
  log(req, 'plan.toggle', { entity: 'membership_plans', id: toInt(req.params.id) });
  res.redirect('/app/memberships#plans');
}, '/app/memberships'));

router.post('/memberships/:id/cancel', action((req, res) => {
  svc.cancelMembership(toInt(req.params.id));
  log(req, 'membership.cancel', { entity: 'memberships', id: toInt(req.params.id) });
  flash(req, 'success', 'flash.membershipCancelled');
  res.redirect('/app/memberships');
}, '/app/memberships'));

// ---------- Loyalty settings ----------

router.post('/settings/loyalty', action((req, res) => {
  const every = toInt(req.body.stamp_every);
  if (every < 0 || every > 50) throw new UserError('err.stampEvery');
  settings.set({ stamp_every: String(every) });
  log(req, 'settings.loyalty', { detail: { stamp_every: every } });
  flash(req, 'success', 'flash.saved');
  res.redirect('/app/settings#loyalty');
}, '/app/settings'));

// ---------- Stock ----------

router.get('/stock', (req, res) => {
  const supplies = svc.listSupplies({ includeInactive: true });
  const moves = Object.fromEntries(supplies.map((s) => [s.id, svc.listMoves(s.id, 8)]));
  res.render('app/stock', { title: req.t('stock.title'), supplies, moves, priceList: svc.getPriceList() });
});

router.post('/stock', action((req, res) => {
  svc.createSupply(req.body, req.session.user.id);
  log(req, 'stock.add', { entity: 'supplies', detail: { name: req.body.name } });
  flash(req, 'success', 'flash.saved');
  res.redirect('/app/stock');
}, '/app/stock'));

router.post('/stock/:id', action((req, res) => {
  svc.updateSupply(toInt(req.params.id), req.body);
  log(req, 'stock.update', { entity: 'supplies', id: toInt(req.params.id) });
  flash(req, 'success', 'flash.saved');
  res.redirect(`/app/stock#supply-${req.params.id}`);
}, '/app/stock'));

router.post('/stock/:id/move', action((req, res) => {
  const r = svc.moveStock(toInt(req.params.id), {
    type: String(req.body.type), qty: req.body.qty, cost: req.body.cost, note: req.body.note, recordExpense: req.body.record_expense === '1',
  }, req.session.user.id);
  log(req, 'stock.move', { entity: 'supplies', id: toInt(req.params.id), detail: { type: req.body.type, qty: req.body.qty, change: r.change } });
  flash(req, 'success', r.expenseId ? 'flash.stockAndExpense' : 'flash.stockSaved');
  res.redirect(`/app/stock#supply-${req.params.id}`);
}, '/app/stock'));

router.post('/stock/:id/toggle', action((req, res) => {
  svc.toggleSupply(toInt(req.params.id));
  log(req, 'stock.toggle', { entity: 'supplies', id: toInt(req.params.id) });
  res.redirect('/app/stock');
}, '/app/stock'));

// ---------- Expenses ----------

router.get('/expenses', (req, res) => {
  const month = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : today().slice(0, 7);
  res.render('app/expenses', {
    title: req.t('exp.title'), month, rows: svc.listExpenses(month), byCategory: svc.expensesByCategory(month),
    categories: svc.EXPENSE_CATEGORIES, today: today(),
  });
});

router.post('/expenses', action((req, res) => {
  svc.addExpense(req.body, req.session.user.id);
  log(req, 'expense.add', { entity: 'expenses', detail: { category: req.body.category, amount: toInt(req.body.amount), date: req.body.date } });
  flash(req, 'success', 'flash.expenseAdded');
  res.redirect(`/app/expenses?month=${String(req.body.date || today()).slice(0, 7)}`);
}, '/app/expenses'));

router.post('/expenses/:id/delete', action((req, res) => {
  svc.deleteExpense(toInt(req.params.id));
  log(req, 'expense.delete', { entity: 'expenses', id: toInt(req.params.id) });
  flash(req, 'success', 'flash.expenseDeleted');
  res.redirect(`/app/expenses${req.body.month ? `?month=${encodeURIComponent(req.body.month)}` : ''}`);
}, '/app/expenses'));

// ---------- Exports & activity log ----------

router.get('/exports/:type.csv', (req, res) => {
  const month = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : today().slice(0, 7);
  const csv = svc.exportCsv(req.params.type, month, { sep: req.lang === 'id' ? ';' : ',' });
  if (csv === null) return res.status(404).render('error', { title: req.t('error.notFoundTitle'), message: req.t('error.pageMissing') });
  log(req, 'export', { detail: { type: req.params.type, month } });
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="sparkle-${req.params.type}-${month}.csv"`);
  res.send(csv);
});

router.get('/activity', (req, res) => {
  const filters = {
    userId: toInt(req.query.user) || null,
    action: /^[a-z_.]{1,40}$/.test(req.query.action || '') ? req.query.action : '',
    date: /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : '',
  };
  res.render('app/activity', {
    title: req.t('act.title'), rows: svc.listAudit(filters), filters, actions: svc.auditActions(),
    users: db.prepare('SELECT id, name FROM users ORDER BY name').all(),
  });
});

module.exports = router;
