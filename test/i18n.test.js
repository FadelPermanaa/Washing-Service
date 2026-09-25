const test = require('node:test');
const assert = require('node:assert/strict');
const en = require('../src/i18n/en');
const id = require('../src/i18n/id');
const fs = require('node:fs');
const path = require('node:path');

test('English and Indonesian dictionaries have the same keys', () => {
  const a = Object.keys(en).sort();
  const b = Object.keys(id).sort();
  assert.deepEqual(a.filter((k) => !b.includes(k)), [], 'missing in id.js');
  assert.deepEqual(b.filter((k) => !a.includes(k)), [], 'missing in en.js');
});

test('placeholders match between languages', () => {
  const ph = (s) => (typeof s === 'string' ? (s.match(/\{\w+\}/g) || []).sort() : []);
  for (const k of Object.keys(en)) assert.deepEqual(ph(id[k]), ph(en[k]), k);
});

test('every key used in views and routes exists', () => {
  const root = path.join(__dirname, '..');
  const files = [];
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.(ejs|js)$/.test(e.name)) files.push(p);
  });
  walk(path.join(root, 'views'));
  walk(path.join(root, 'src'));
  const missing = new Set();
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    for (const m of src.matchAll(/\b(?:t|tr|req\.t)\('([a-zA-Z]+\.[\w.-]+)'/g)) if (!(m[1] in en)) missing.add(`${m[1]} (${path.relative(root, f)})`);
    for (const m of src.matchAll(/UserError\('([\w.]+)'/g)) if (!(m[1] in en)) missing.add(`${m[1]} (${path.relative(root, f)})`);
    for (const m of src.matchAll(/flash\(req, '\w+', '([\w.]+)'/g)) if (!(m[1] in en)) missing.add(`${m[1]} (${path.relative(root, f)})`);
  }
  assert.deepEqual([...missing], []);
});
