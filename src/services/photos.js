// Before/after photos of a wash. Files live in DATA_DIR/uploads; only real JPEG/PNG/WebP images are accepted.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { db, now, DATA_DIR } = require('../db');
const { UserError } = require('./common');
const { canWorkOn } = require('./work');

const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_PER_KIND = 8;

/** Recognise an image by its first bytes (the file name and browser-sent type are not trusted). */
function detectImage(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { mime: 'image/jpeg', ext: 'jpg' };
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { mime: 'image/png', ext: 'png' };
  if (buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') return { mime: 'image/webp', ext: 'webp' };
  return null;
}

function listPhotos(txId) {
  const rows = db.prepare(`SELECT p.*, u.name AS created_by_name FROM transaction_photos p LEFT JOIN users u ON u.id = p.created_by
    WHERE p.transaction_id = ? ORDER BY p.id`).all(txId);
  return { before: rows.filter((r) => r.kind === 'before'), after: rows.filter((r) => r.kind === 'after'), all: rows };
}

function savePhotos(txId, kind, files, user) {
  if (!['before', 'after'].includes(kind)) throw new UserError('err.photoKind');
  const t = db.prepare('SELECT * FROM transactions WHERE id = ?').get(txId);
  if (!t) throw new UserError('err.txNotFound');
  if (!canWorkOn(user, t)) throw new UserError('err.notYourJob');
  if (t.status === 'cancelled') throw new UserError('err.cancelled');
  if (user.role === 'washer' && t.status !== 'washing') throw new UserError('err.photoLocked');
  if (!files?.length) throw new UserError('err.photoMissing');

  const existing = db.prepare('SELECT COUNT(*) AS n FROM transaction_photos WHERE transaction_id = ? AND kind = ?').get(txId, kind).n;
  if (existing + files.length > MAX_PER_KIND) throw new UserError('err.photoTooMany', { n: MAX_PER_KIND });

  // Validate everything first so a bad file doesn't leave half an upload behind.
  const checked = files.map((f) => {
    if (f.size > MAX_BYTES) throw new UserError('err.photoTooBig');
    const type = detectImage(f.buffer);
    if (!type) throw new UserError('err.photoType');
    return { buffer: f.buffer, ...type };
  });

  const month = now().slice(0, 7);
  fs.mkdirSync(path.join(UPLOAD_DIR, month), { recursive: true });
  const ids = [];
  for (const f of checked) {
    const rel = `${month}/${crypto.randomBytes(12).toString('hex')}.${f.ext}`;
    fs.writeFileSync(path.join(UPLOAD_DIR, rel), f.buffer, { flag: 'wx' });
    ids.push(Number(db.prepare(`INSERT INTO transaction_photos (transaction_id, kind, filename, mime, size, created_at, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(txId, kind, rel, f.mime, f.buffer.length, now(), user.id).lastInsertRowid));
  }
  return ids;
}

/** Photo row plus its absolute file path, or null. Pass txId to require that the photo belongs to it. */
function photoFile(id, { txId } = {}) {
  const p = db.prepare('SELECT * FROM transaction_photos WHERE id = ?').get(id);
  if (!p || (txId && p.transaction_id !== txId)) return null;
  const file = path.resolve(UPLOAD_DIR, p.filename);
  if (!file.startsWith(path.resolve(UPLOAD_DIR) + path.sep) || !fs.existsSync(file)) return null;
  return { ...p, file };
}

function deletePhoto(id, user) {
  const p = db.prepare('SELECT p.*, x.washer_id, x.status FROM transaction_photos p JOIN transactions x ON x.id = p.transaction_id WHERE p.id = ?').get(id);
  if (!p) throw new UserError('err.photoMissing');
  if (user.role === 'washer' && (p.created_by !== user.id || p.status !== 'washing')) throw new UserError('err.notYourJob');
  db.prepare('DELETE FROM transaction_photos WHERE id = ?').run(id);
  fs.rm(path.join(UPLOAD_DIR, p.filename), { force: true }, () => {});
  return p.transaction_id;
}

module.exports = { detectImage, listPhotos, savePhotos, photoFile, deletePhoto, MAX_BYTES, MAX_PER_KIND };
