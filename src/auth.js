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

/** Allow only the given roles (admin always passes). */
function requireRole(...roles) {
  return (req, res, next) => {
    const role = req.session.user?.role;
    if (role === 'admin' || roles.includes(role)) return next();
    res.status(403).render('error', { title: req.t('error.deniedTitle'), message: req.t('error.denied') });
  };
}

const requireAdmin = requireRole('admin');

module.exports = { hashPassword, verifyPassword, requireLogin, requireRole, requireAdmin };
