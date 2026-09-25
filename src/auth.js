const crypto = require('node:crypto');

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const candidate = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, 'hex');
  return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}

function requireLogin(req, res, next) {
  if (req.session.user) return next();
  res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
}

function requireAdmin(req, res, next) {
  if (req.session.user?.role === 'admin') return next();
  res.status(403).render('error', { title: req.t('error.deniedTitle'), message: req.t('error.denied') });
}

module.exports = { hashPassword, verifyPassword, requireLogin, requireAdmin };
