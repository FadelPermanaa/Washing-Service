const express = require('express');
const { today } = require('../db');
const svc = require('../services');
const { flash, action, notFound } = require('./util');

const router = express.Router();

router.get('/', (req, res) => {
  res.render('app/dashboard', {
    title: req.t('dash.title'),
    stats: svc.dashboardStats(),
    queue: svc.queue(),
    recent: svc.listTransactions({ date: today() }).slice(0, 8),
    bookings: svc.upcomingToday(),
  });
});

router.get('/queue', (req, res) => {
  const queue = svc.queue();
  const ids = [...queue.washing, ...queue.done].map((r) => r.id);
  res.render('app/queue', {
    title: req.t('queue.title'), queue, methods: svc.PAYMENT_METHODS,
    washers: svc.listWashers(), bays: svc.listBays(), progress: svc.checkProgress(ids),
  });
});

router.get('/transactions/new', (req, res) => {
  res.render('app/new', {
    title: req.t('new.title'),
    priceList: svc.getPriceList(),
    methods: svc.PAYMENT_METHODS,
    plate: svc.normalizePlate(req.query.plate),
  });
});

router.post('/transactions', action((req, res) => {
  const id = svc.createTransaction(req.body, req.session.user.id);
  flash(req, 'success', 'flash.added');
  res.redirect(req.body.print === '1' ? `/app/transactions/${id}?print=1` : '/app/queue');
}, '/app/transactions/new'));

router.get('/api/vehicle', (req, res) => {
  const v = svc.findVehicleByPlate(req.query.plate);
  res.json({ vehicle: v && { ...v, stamp: svc.stampStatus(v), memberships: svc.activeMemberships(v.id) } });
});

/** Live price preview for the new-wash form (same rules as saving). */
router.get('/api/quote', (req, res) => {
  const q = req.query;
  try {
    const r = svc.quote({
      vehicleTypeId: svc.toInt(q.vehicle_type_id), packageId: svc.toInt(q.package_id), addonIds: [].concat(q.addon_ids || []),
      discount: q.discount, promoCode: q.promo_code, useStamp: q.use_stamp === '1', useMembership: q.use_membership === '1', plate: q.plate,
    }, { soft: true });
    res.json({
      ok: true,
      packageName: res.locals.L(r.pkg), packagePrice: r.packagePrice, addonsTotal: r.addonsTotal,
      membershipDiscount: r.membershipDiscount, freeDiscount: r.freeDiscount, promoDiscount: r.promoDiscount, discount: r.discount, total: r.total,
      promoError: r.promoError ? req.t(r.promoError.key, r.promoError.params) : null,
      promoLabel: r.promo ? `${r.promo.code}${r.promo.type === 'percent' ? ` (${r.promo.value}%)` : ''}` : null,
      stamps: r.stamps, vehicleKnown: Boolean(r.vehicle),
      membership: r.membership && { id: r.membership.id, washesLeft: r.membership.washes_left, expiresOn: r.membership.expires_on, name: res.locals.L(r.membership, 'plan_name') },
    });
  } catch (err) {
    if (!(err instanceof svc.UserError)) throw err;
    res.json({ ok: false, error: req.t(err.key, err.params) });
  }
});

router.get('/transactions', (req, res) => {
  const filters = {
    date: /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : (req.query.date === 'all' ? '' : today()),
    status: ['waiting', 'washing', 'done', 'cancelled', 'unpaid'].includes(req.query.status) ? req.query.status : '',
    q: String(req.query.q || '').slice(0, 50),
  };
  res.render('app/transactions', { title: req.t('tx.title'), rows: svc.listTransactions(filters), filters });
});

router.get('/transactions/:id', (req, res) => {
  const t = svc.getTransaction(svc.toInt(req.params.id));
  if (!t) return notFound(req, res, 'err.txNotFound');
  res.render('app/transaction', {
    title: t.code, tx: t, methods: svc.PAYMENT_METHODS, autoPrint: req.query.print === '1',
    washers: svc.listWashers(), bays: svc.listBays(), messages: svc.notifications.forTransaction(t.id),
  });
});

router.post('/transactions/:id/status', action((req, res) => {
  svc.changeStatus(svc.toInt(req.params.id), String(req.body.action), { washerId: req.body.washer_id, bayId: req.body.bay_id });
  flash(req, 'success', `flash.${req.body.action}`);
  res.redirect(req.body.back === 'detail' ? `/app/transactions/${req.params.id}` : '/app/queue');
}, '/app/queue'));

router.post('/transactions/:id/payments', action((req, res) => {
  const r = svc.recordPayment(svc.toInt(req.params.id), { amount: req.body.amount, method: String(req.body.method) }, req.session.user.id);
  flash(req, 'success', r.due > 0 ? 'flash.partPaid' : 'flash.paid', { due: res.locals.rupiah(r.due) });
  res.redirect(`/app/transactions/${req.params.id}`);
}, '/app/queue'));

router.post('/transactions/:id/pay', action((req, res) => {
  svc.markPaid(svc.toInt(req.params.id), String(req.body.method), req.session.user.id);
  flash(req, 'success', 'flash.paid');
  res.redirect(req.body.back === 'detail' ? `/app/transactions/${req.params.id}` : '/app/queue');
}, '/app/queue'));

router.get('/vehicles', (req, res) => {
  const q = String(req.query.q || '').slice(0, 50);
  res.render('app/vehicles', { title: req.t('veh.title'), rows: svc.listVehicles(q), q });
});

router.get('/reports', (req, res) => {
  res.render('app/reports', { title: req.t('rep.title'), report: svc.monthlyReport(req.query.month) });
});

// ---------- Bookings ----------

router.get('/bookings', (req, res) => {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : today();
  res.render('app/bookings', { title: req.t('bookings.title'), date, rows: svc.listBookings(date) });
});

router.post('/bookings/:id', action((req, res) => {
  const id = svc.toInt(req.params.id);
  if (req.body.op === 'check_in') {
    const txId = svc.checkIn(id, req.session.user.id);
    flash(req, 'success', 'flash.checkedIn');
    return res.redirect(req.body.back === 'dashboard' ? '/app' : `/app/transactions/${txId}`);
  }
  const b = svc.staffUpdate(id, String(req.body.op));
  flash(req, 'success', `flash.booking.${req.body.op}`);
  res.redirect(req.body.back === 'dashboard' ? '/app' : `/app/bookings?date=${b.date}`);
}, '/app/bookings'));

// ---------- WhatsApp outbox ----------

router.get('/whatsapp', (req, res) => {
  const status = req.query.all === '1' ? '' : 'open';
  res.render('app/whatsapp', {
    title: req.t('wa.title'), rows: svc.notifications.outbox({ status }), showAll: !status, gateway: svc.notifications.hasGateway(),
  });
});

router.post('/whatsapp/:id', action((req, res) => {
  const id = svc.toInt(req.params.id);
  if (req.body.op === 'retry') svc.notifications.retry(id);
  else svc.notifications.markHandled(id, req.session.user.id);
  if (req.get('accept')?.includes('application/json')) return res.json({ ok: true });
  res.redirect(req.body.back || '/app/whatsapp');
}, '/app/whatsapp'));

// ---------- Memberships (selling is a cashier job; plans are set up by admins) ----------

router.get('/memberships', (req, res) => {
  const q = String(req.query.q || '').slice(0, 50);
  res.render('app/memberships', {
    title: req.t('mem.title'), q, rows: svc.listMemberships(q), plans: svc.listPlans({ activeOnly: true }),
    allPlans: req.session.user.role === 'admin' ? svc.listPlans() : [], priceList: svc.getPriceList(), methods: svc.PAYMENT_METHODS,
    today: today(),
    plate: svc.normalizePlate(req.query.plate),
  });
});

router.post('/memberships', action((req, res) => {
  svc.sellMembership(req.body, req.session.user.id);
  flash(req, 'success', 'flash.membershipSold', { plate: svc.normalizePlate(req.body.plate) });
  res.redirect('/app/memberships');
}, '/app/memberships'));

module.exports = router;
