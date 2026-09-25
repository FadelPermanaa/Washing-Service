const { UserError } = require('../services');

function flash(req, type, key, params = {}) {
  req.session.flash = { type, key, params };
}

function sameOriginReferer(req) {
  try {
    const url = new URL(req.get('Referer'));
    return url.host === req.get('host') ? url.pathname + url.search : null;
  } catch {
    return null;
  }
}

/** Wrap a POST handler: UserErrors become a flash message + redirect back. */
function action(fn, fallback = '/app') {
  return async (req, res, next) => {
    try {
      await fn(req, res);
    } catch (err) {
      if (!(err instanceof UserError)) return next(err);
      flash(req, 'error', err.key, err.params);
      res.redirect(sameOriginReferer(req) || fallback);
    }
  };
}

function notFound(req, res, messageKey = 'error.pageMissing') {
  res.status(404).render('error', { title: req.t('error.notFoundTitle'), message: req.t(messageKey) });
}

module.exports = { flash, action, notFound, sameOriginReferer };
