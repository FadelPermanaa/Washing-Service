// "My jobs" for washers, plus checklist ticking (washers on their own jobs; cashiers and admins on any job).
const express = require('express');
const multer = require('multer');
const { db } = require('../db');
const svc = require('../services');
const { verifyCsrf } = require('../security');
const { flash, action, notFound } = require('./util');

// Photos arrive as multipart uploads; the CSRF token is checked after multer has read the form.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: svc.MAX_BYTES, files: svc.MAX_PER_KIND, fields: 10 } });
function receivePhotos(req, res, next) {
  upload.array('photos', svc.MAX_PER_KIND)(req, res, (err) => {
    if (!err) return verifyCsrf(req, res, next);
    const key = err.code === 'LIMIT_FILE_SIZE' ? 'err.photoTooBig' : (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE' ? 'err.photoTooMany' : 'err.photoType');
    req.photoError = new svc.UserError(key, { n: svc.MAX_PER_KIND });
    req.body ??= {};
    return verifyCsrf(req, res, next);
  });
}

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
  res.render('app/job', { title: `${t.plate} · ${t.code}`, tx: t, photos: svc.listPhotos(t.id) });
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

// ---------- Photos ----------

router.post(['/jobs/:id/photos', '/transactions/:id/photos'], receivePhotos, action((req, res) => {
  if (req.photoError) throw req.photoError;
  const id = svc.toInt(req.params.id);
  const ids = svc.savePhotos(id, String(req.body.kind || req.query.kind), req.files, req.session.user);
  if (req.get('accept')?.includes('application/json')) return res.json({ ok: true, ids });
  flash(req, 'success', 'flash.photosSaved', { n: ids.length });
  res.redirect(req.body.back === 'detail' ? `/app/transactions/${id}#photos` : `/app/jobs/${id}#photos`);
}, '/app/jobs'));

router.get('/photos/:id', (req, res) => {
  const p = svc.photoFile(svc.toInt(req.params.id));
  const t = p && db.prepare('SELECT * FROM transactions WHERE id = ?').get(p.transaction_id);
  if (!p || !svc.canWorkOn(req.session.user, t)) return notFound(req, res);
  res.set('Cache-Control', 'private, max-age=86400');
  res.type(p.mime).sendFile(p.file);
});

router.post('/photos/:id/delete', action((req, res) => {
  const txId = svc.deletePhoto(svc.toInt(req.params.id), req.session.user);
  flash(req, 'success', 'flash.photoDeleted');
  res.redirect(req.body.back === 'detail' ? `/app/transactions/${txId}#photos` : `/app/jobs/${txId}#photos`);
}, '/app/jobs'));

module.exports = router;
