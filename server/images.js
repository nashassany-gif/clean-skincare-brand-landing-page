'use strict';
/**
 * Admin product image uploads. Files live in DATA_DIR/uploads (next to the
 * SQLite database, so the existing online-backup discipline covers them by
 * directory backup). Format is detected by magic bytes, never by the claimed
 * Content-Type; filenames are server-generated.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DATA_DIR } = require('./database');

const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const MAX_BYTES = 2 * 1024 * 1024;

function sniff(buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpg';
  if (buffer.length >= 8 && buffer.readUInt32BE(0) === 0x89504e47 && buffer.readUInt32BE(4) === 0x0d0a1a0a) return 'png';
  if (buffer.length >= 12 && buffer.toString('latin1', 0, 4) === 'RIFF' && buffer.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  return null;
}

const FILE_PATTERN = /^[a-f0-9]{24}\.(jpg|png|webp)$/;

/** Save a validated image buffer; returns the public path `/uploads/<name>`. */
function save(buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw Object.assign(new Error('Empty upload.'), { status: 400 });
  if (buffer.length > MAX_BYTES) throw Object.assign(new Error('Image must be 2 MB or smaller.'), { status: 413 });
  const ext = sniff(buffer);
  if (!ext) throw Object.assign(new Error('Only JPEG, PNG or WebP images are accepted.'), { status: 400 });
  fs.mkdirSync(UPLOAD_DIR, { recursive: true, mode: 0o700 });
  const name = crypto.randomBytes(12).toString('hex') + '.' + ext;
  fs.writeFileSync(path.join(UPLOAD_DIR, name), buffer, { mode: 0o600 });
  return '/uploads/' + name;
}

/** Resolve a public `/uploads/...` path to a file inside UPLOAD_DIR, or null. */
function resolve(publicPath) {
  if (typeof publicPath !== 'string') return null;
  const base = path.basename(publicPath);
  if (!FILE_PATTERN.test(base)) return null;
  const target = path.join(UPLOAD_DIR, base);
  return path.dirname(target) === UPLOAD_DIR ? target : null;
}

/** Delete an uploaded file (only files we generated). Missing files are fine. */
function remove(publicPath) {
  const target = resolve(publicPath);
  if (target) try { fs.unlinkSync(target); } catch (_) {}
}

module.exports = { save, resolve, remove, MAX_BYTES, UPLOAD_DIR };
