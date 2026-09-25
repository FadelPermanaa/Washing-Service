// "My jobs" for washers, plus checklist ticking (washers on their own jobs; cashiers and admins on any job).
const express = require('express');
const { db } = require('../db');
const svc = require('../services');
const { flash, action, notFound } = require('./util');

const router = express.Router();

function loadJob(req) {
  const t = svc.getTransaction(svc.toInt(req.params.id));
  if (!t || !svc.canWorkOn(req.session.user, t)) return null;
  return t;
}

router.get('/jobs', (req, res) => {
  res.render('app/jobs', { title: req.t('jobs.title'), jobs: svc.jobsFor(req.session.user.id) });
});

router.get('/jobs/:id', (req, res) => {
  const t = loadJob(req);
  if (!t) return notFound(req, res, 'err.txNotFound');
  res.render('app/job', { title: `${t.plate} · ${t.code}`, tx: t });
});

router.post('/jobs/:id/checks/:checkId', action((req, res) => {
  svc.toggleCheck(svc.toInt(req.params.id), svc.toInt(req.params.checkId), req.session.user);
  if (req.get('accept')?.includes('application/json')) {
    const c = db.prepare('SELECT done_at FROM transaction_checks WHERE id = ?').get(svc.toInt(req.params.checkId));
    return res.json({ ok: true, done: Boolean(c?.done_at) });
  }
  res.redirect(req.body.back === 'detail' ? `/app/transactions/${req.params.id}` : `/app/jobs/${req.params.id}`);
}, '/app/jobs'));

router.post('/jobs/:id/finish', action((req, res) => {
  const t = loadJob(req);
  if (!t) throw new svc.UserError('err.notYourJob');
  svc.finishWash(t.id);
  flash(req, 'success', 'flash.finish');
  res.redirect(req.session.user.role === 'washer' ? '/app/jobs' : '/app/queue');
}, '/app/jobs'));

module.exports = router;
