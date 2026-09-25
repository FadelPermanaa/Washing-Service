const dicts = { en: require('./en'), id: require('./id') };

const LANGS = Object.keys(dicts);
const DEFAULT_LANG = LANGS.includes(process.env.DEFAULT_LANG) ? process.env.DEFAULT_LANG : 'id';

/**
 * Returns t(key, params) for a language.
 * Param values may be plain values, { key } (translated), or { en, id } (picked by language).
 */
function translator(lang) {
  const dict = dicts[lang] || dicts[DEFAULT_LANG];
  function t(key, params = {}) {
    const v = dict[key] ?? dicts.en[key] ?? key;
    if (typeof v === 'function') return v(params);
    if (typeof v !== 'string') return v;
    return v.replace(/\{(\w+)\}/g, (m, k) => {
      const p = params[k];
      if (p == null) return m;
      if (typeof p === 'object') return p.key ? t(p.key) : (p[lang] || p.en || '');
      return String(p);
    });
  }
  return t;
}

/** Pick the Indonesian variant of a catalog field (name_id, description_id, …) when available. */
function localField(lang) {
  return (obj, field = 'name') => {
    if (!obj) return '';
    if (lang === 'id' && obj[`${field}_id`]) return obj[`${field}_id`];
    return obj[field] ?? '';
  };
}

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/** Express middleware: ?lang=xx sets a cookie; otherwise cookie; otherwise DEFAULT_LANG. */
function i18nMiddleware(req, res, next) {
  let lang = parseCookies(req.headers.cookie).lang;
  if (LANGS.includes(req.query.lang)) {
    lang = req.query.lang;
    res.cookie('lang', lang, { maxAge: 365 * 24 * 60 * 60 * 1000, sameSite: 'lax', httpOnly: false });
  }
  if (!LANGS.includes(lang)) lang = DEFAULT_LANG;
  req.lang = lang;
  req.t = translator(lang);
  res.locals.lang = lang;
  res.locals.t = req.t;
  res.locals.tr = req.t; // alias for views where `t` is a transaction
  res.locals.L = localField(lang);
  res.locals.locale = dicts[lang].locale;
  res.locals.langUrl = (code) => {
    const url = new URL(req.originalUrl, 'http://local');
    url.searchParams.set('lang', code);
    return url.pathname + url.search;
  };
  next();
}

module.exports = { translator, localField, i18nMiddleware, LANGS, DEFAULT_LANG, dicts };
