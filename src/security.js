const crypto = require('node:crypto');

/**
 * CSRF protection (synchronizer token). Every POST must send the session's token as the `_csrf`
 * form field or the `x-csrf-token` header. Views get it as `csrf`.
 * For multipart forms, call `verifyCsrf` after the upload middleware has parsed the body.
 */
function csrfToken(req) {
  if (!req.session.csrf) req.session.csrf = crypto.randomBytes(24).toString('hex');
  return req.session.csrf;
}

function tokenMatches(req) {
  const sent = String(req.body?._csrf || req.get('x-csrf-token') || '');
  const expected = req.session?.csrf || '';
  if (!sent || !expected || sent.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(sent), Buffer.from(expected));
}

function rejectCsrf(req, res) {
  const t = req.t || ((k) => k);
  res.status(403).render('error', { title: t('error.csrfTitle'), message: t('error.csrf') });
}

function csrf({ skip = () => false } = {}) {
  return (req, res, next) => {
    res.locals.csrf = csrfToken(req);
    if (req.method !== 'POST' || skip(req)) return next();
    if (tokenMatches(req)) return next();
    return rejectCsrf(req, res);
  };
}

function verifyCsrf(req, res, next) {
  if (tokenMatches(req)) return next();
  return rejectCsrf(req, res);
}

/** Small in-memory fixed-window rate limiter (per client IP and bucket name). */
function rateLimit({ name, max, windowMs }) {
  const hits = new Map();
  setInterval(() => {
    const cutoff = Date.now() - windowMs;
    for (const [k, v] of hits) if (v.start < cutoff) hits.delete(k);
  }, windowMs).unref();

  return (req, res, next) => {
    if (process.env.DISABLE_RATE_LIMIT === '1') return next();
    const key = `${name}:${req.ip}`;
    const nowMs = Date.now();
    let entry = hits.get(key);
    if (!entry || nowMs - entry.start > windowMs) {
      entry = { start: nowMs, count: 0 };
      hits.set(key, entry);
    }
    entry.count++;
    if (entry.count <= max) return next();
    res.set('Retry-After', String(Math.ceil((entry.start + windowMs - nowMs) / 1000)));
    const t = req.t || ((k) => k);
    return res.status(429).render('error', { title: t('error.tooManyTitle'), message: t('error.tooMany') });
  };
}

module.exports = { csrf, verifyCsrf, rateLimit };
