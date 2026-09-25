// Public: online booking, booking status page, and the private tracking link for a wash.
const express = require('express');
const settings = require('../settings');
const { rateLimit } = require('../security');
const svc = require('../services');
const { flash, notFound } = require('./util');

const router = express.Router();

function bookingForm(req, res, values = {}) {
  const priceList = svc.getPriceList();
  const days = svc.bookableDays();
  const v = {
    vehicle_type_id: String(values.vehicle_type_id || priceList.types[1]?.id || priceList.types[0]?.id || ''),
    package_id: String(values.package_id || priceList.packages[0]?.id || ''),
    date: days.includes(values.date) ? values.date : days[0],
    time: values.time || '',
    addon_ids: [].concat(values.addon_ids || []).map(String),
    customer_name: values.customer_name || '',
    phone: values.phone || '',
    plate: values.plate || '',
    notes: values.notes || '',
  };
  res.render('booking', {
    title: req.t('book.title'), priceList, days, v,
    slots: svc.slotsFor(v.date, v.package_id),
    enabled: settings.bool('booking_enabled'),
  });
}

router.get('/booking', (req, res) => bookingForm(req, res, req.query));

router.get('/booking/slots', (req, res) => {
  res.json({ slots: svc.slotsFor(String(req.query.date || ''), req.query.package_id) });
});

router.post('/booking', rateLimit({ name: 'booking', max: 6, windowMs: 10 * 60 * 1000 }), (req, res, next) => {
  try {
    const b = svc.createBooking(req.body, { lang: req.lang });
    res.redirect(`/b/${b.token}?new=1`);
  } catch (err) {
    if (!(err instanceof svc.UserError)) return next(err);
    res.locals.flash = { type: 'error', message: req.t(err.key, err.params) };
    res.status(422);
    bookingForm(req, res, req.body);
  }
});

router.get('/b/:token', (req, res) => {
  const b = svc.getBookingByToken(req.params.token);
  if (!b) return notFound(req, res, 'err.bookingNotFound');
  res.render('booking-status', { title: b.code, b, isNew: req.query.new === '1', canCancel: svc.customerCanCancel(b) });
});

router.post('/b/:token/cancel', (req, res, next) => {
  const back = `/b/${encodeURIComponent(req.params.token)}`;
  try {
    svc.cancelByCustomer(req.params.token);
    flash(req, 'success', 'flash.bookingCancelled');
  } catch (err) {
    if (!(err instanceof svc.UserError)) return next(err);
    flash(req, 'error', err.key, err.params);
  }
  res.redirect(back);
});

router.get('/t/:token', (req, res) => {
  const t = svc.getTransactionByToken(req.params.token);
  if (!t) return notFound(req, res, 'err.txNotFound');
  res.render('track', { title: `${t.plate} · ${t.code}`, tx: t });
});

module.exports = router;
