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
  res.json({ vehicle: svc.findVehicleByPlate(req.query.plate) });
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
    washers: svc.listWashers(), bays: svc.listBays(),
  });
});

router.post('/transactions/:id/status', action((req, res) => {
  svc.changeStatus(svc.toInt(req.params.id), String(req.body.action), { washerId: req.body.washer_id, bayId: req.body.bay_id });
  flash(req, 'success', `flash.${req.body.action}`);
  res.redirect(req.body.back === 'detail' ? `/app/transactions/${req.params.id}` : '/app/queue');
}, '/app/queue'));

router.post('/transactions/:id/pay', action((req, res) => {
  svc.markPaid(svc.toInt(req.params.id), String(req.body.method));
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

module.exports = router;
