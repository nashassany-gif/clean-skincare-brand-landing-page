'use strict';
/**
 * Product catalog. The `products` table in SQLite is the single source of truth
 * for names, prices, stock, descriptions, images and publish status. The browser
 * only ever sends `{ id, qty }`; everything monetary is recomputed from the
 * database here. Never move these numbers into the client.
 *
 * Lazy `require('./database')` inside functions on purpose: database.js requires
 * this module for seeding, so a top-level require would capture a half-built
 * exports object.
 */
const db = () => require('./database').db;

const CURRENCY = 'cny';

/**
 * Shipping rules in CNY cents. Kept server-side so a client cannot pick a
 * cheaper rate. Placeholder values — confirm real rates before going live.
 */
const SHIPPING = {
  standard: { label: 'Standard', cents: 1200, freeOverCents: 15000 },
  express: { label: 'Express', cents: 3200, freeOverCents: null }
};

/**
 * Demo tax rate. 0 = prices are treated as tax-inclusive (no separate tax line).
 * A real deployment must decide its own tax strategy.
 */
const TAX_RATE = 0;

const MAX_QTY_PER_LINE = 9;

const STATUSES = ['draft', 'active', 'archived'];

/**
 * Seed catalog. These are the fictional demo products shipped with the
 * storefront; replace them in the admin before real trading. Seeded only when
 * the products table is empty (see database.js migrate()).
 */
const SEED_PRODUCTS = [
  { id: 'melt', name: 'Melt Cleansing Oil', size: '150 ml', priceCents: 4600, stock: 40, sort: 1, image: 'assets/images/product-melt.webp', description: 'The cleansing step in this fictional collection. The amber bottle, sample formula and ritual illustrate the concept; cleansing performance and skin effects have not been verified.' },
  { id: 'drench', name: 'Drench Renewal Serum', size: '30 ml', priceCents: 6800, stock: 25, sort: 2, image: 'assets/images/product-drench.webp', description: 'The serum step in this fictional collection. Bakuchiol and squalane are illustrative formula references, not a verified formulation or a claim of retinol-equivalent benefits, tolerability or results.' },
  { id: 'keeper', name: 'Keeper Barrier Cream', size: '50 ml', priceCents: 5400, stock: 30, sort: 3, image: 'assets/images/product-keeper.webp', description: 'The cream step in this fictional collection. The jar and sample formula illustrate a richer texture; barrier effects, customer feedback and performance have not been verified.' },
  { id: 'rest', name: 'Rest Clay Mask', size: '75 ml', priceCents: 3800, stock: 15, sort: 4, image: 'assets/images/product-rest.webp', description: 'A clay-mask concept that rounds out the collection. Its colour, texture and suggested ritual are illustrative; no customer story, skin benefit or tolerability claim has been verified.' }
];

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;

function camel(row) {
  if (!row) return null;
  return { id: row.id, name: row.name, size: row.size, priceCents: row.price_cents, stock: row.stock, description: row.description, image: row.image, status: row.status, sort: row.sort, createdAt: row.created_at, updatedAt: row.updated_at };
}

/** Any product, including drafts/archived (needed for order history). */
function getProduct(id) {
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) return null;
  return camel(db().prepare('SELECT * FROM products WHERE id=?').get(id));
}

/** A product the storefront may sell right now. */
function getOrderable(id) {
  const p = getProduct(id);
  return p && p.status === 'active' ? p : null;
}

/** Active products in display order, with computed availability. */
function listPublic() {
  const held = db().prepare("SELECT product_id, COALESCE(SUM(CASE WHEN action='reserve' THEN qty ELSE -qty END),0) AS held FROM stock_ledger GROUP BY product_id").all();
  const heldById = new Map(held.map(r => [r.product_id, r.held]));
  return db().prepare("SELECT * FROM products WHERE status='active' ORDER BY sort,id").all()
    .map(r => ({ ...camel(r), available: Math.max(0, r.stock - (heldById.get(r.id) || 0)) }));
}

/** All products for the admin, with availability and deletability. */
function listAll() {
  const held = db().prepare("SELECT product_id, COALESCE(SUM(CASE WHEN action='reserve' THEN qty ELSE -qty END),0) AS held FROM stock_ledger GROUP BY product_id").all();
  const heldById = new Map(held.map(r => [r.product_id, r.held]));
  const referenced = new Set(db().prepare('SELECT DISTINCT product_id AS id FROM order_items UNION SELECT DISTINCT product_id AS id FROM stock_ledger').all().map(r => r.id));
  return db().prepare('SELECT * FROM products ORDER BY sort,id').all()
    .map(r => ({ ...camel(r), available: Math.max(0, r.stock - (heldById.get(r.id) || 0)), deletable: !referenced.has(r.id) }));
}

function validate(input, { partial = false } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, message: 'Malformed product data.' };
  const out = {};
  const fail = message => ({ ok: false, status: 400, message });
  const text = (key, max, { required = false } = {}) => {
    const v = input[key];
    if (v === undefined) { if (required && !partial) return fail(`${key} is required.`); return null; }
    if (typeof v !== 'string' || v.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v)) return fail(`Invalid ${key}.`);
    return v.trim();
  };
  if (!partial || input.id !== undefined) {
    const id = text('id', 40);
    if (id && id.ok === false) return id;
    if (typeof id === 'string') { if (!ID_PATTERN.test(id)) return fail('Product id must be 1–40 lowercase letters, digits or hyphens.'); out.id = id; }
  }
  for (const [key, max] of [['name', 120], ['size', 60], ['description', 4000], ['image', 200]]) {
    const v = text(key, max, { required: key === 'name' });
    if (v && v.ok === false) return v;
    if (typeof v === 'string') out[key] = v;
  }
  if (out.image !== undefined && out.image && !/^(assets\/images\/|\/uploads\/)[A-Za-z0-9._/-]+$/.test(out.image)) return fail('Invalid image path.');
  for (const [key, min, max] of [['priceCents', 0, 100000000], ['stock', 0, 1000000], ['sort', 0, 9999]]) {
    if (input[key] === undefined) continue;
    if (!Number.isSafeInteger(input[key]) || input[key] < min || input[key] > max) return fail(`Invalid ${key}.`);
    out[key] = input[key];
  }
  if (!partial) {
    for (const key of ['name', 'priceCents', 'stock']) if (out[key] === undefined) return fail(`${key} is required.`);
  }
  if (input.status !== undefined) { if (!STATUSES.includes(input.status)) return fail('Invalid status.'); out.status = input.status; }
  return { ok: true, fields: out };
}

function slugify(name) {
  const base = String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30);
  return base || 'product';
}

function createProduct(input, actor) {
  const v = validate(input);
  if (!v.ok) return v;
  const f = v.fields;
  let id = f.id || slugify(f.name);
  for (let i = 0; db().prepare('SELECT 1 FROM products WHERE id=?').get(id); i++) {
    if (i > 50) return { ok: false, status: 409, message: 'Could not allocate a product id.' };
    id = slugify(f.name) + '-' + (i + 2);
  }
  const now = new Date().toISOString();
  db().prepare('INSERT INTO products(id,name,size,price_cents,stock,description,image,status,sort,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
    .run(id, f.name, f.size || '', f.priceCents, f.stock, f.description || '', f.image || '', f.status || 'draft', f.sort ?? 0, now, now);
  require('./orders').audit(actor, 'product.create', null, { id, name: f.name });
  return { ok: true, product: getProduct(id) };
}

function updateProduct(id, patch, actor) {
  const existing = getProduct(id);
  if (!existing) return { ok: false, status: 404, message: 'Product not found.' };
  const v = validate(patch, { partial: true });
  if (!v.ok) return v;
  if (v.fields.id !== undefined && v.fields.id !== id) return { ok: false, status: 400, message: 'Product id cannot be changed.' };
  const f = v.fields;
  const cols = { name: 'name', size: 'size', description: 'description', image: 'image', priceCents: 'price_cents', stock: 'stock', sort: 'sort', status: 'status' };
  const sets = [], params = [];
  for (const [key, col] of Object.entries(cols)) if (f[key] !== undefined) { sets.push(col + '=?'); params.push(f[key]); }
  if (!sets.length) return { ok: true, product: existing };
  sets.push('updated_at=?'); params.push(new Date().toISOString(), id);
  db().prepare(`UPDATE products SET ${sets.join(',')} WHERE id=?`).run(...params);
  require('./orders').audit(actor, 'product.update', null, { id, fields: Object.keys(f) });
  return { ok: true, product: getProduct(id) };
}

function setStatus(id, status, actor) {
  if (!STATUSES.includes(status)) return { ok: false, status: 400, message: 'Invalid status.' };
  const existing = getProduct(id);
  if (!existing) return { ok: false, status: 404, message: 'Product not found.' };
  db().prepare('UPDATE products SET status=?,updated_at=? WHERE id=?').run(status, new Date().toISOString(), id);
  require('./orders').audit(actor, 'product.status', null, { id, status });
  return { ok: true, product: getProduct(id) };
}

/**
 * A product referenced by any order or stock movement can never be deleted:
 * history must stay intact. Archive it instead.
 */
function deleteProduct(id, actor) {
  const existing = getProduct(id);
  if (!existing) return { ok: false, status: 404, message: 'Product not found.' };
  const referenced = db().prepare('SELECT (SELECT COUNT(*) FROM order_items WHERE product_id=?) + (SELECT COUNT(*) FROM stock_ledger WHERE product_id=?) AS n').get(id).n;
  if (referenced > 0) return { ok: false, status: 409, message: 'This product appears in orders or stock history; archive it instead.' };
  db().prepare('DELETE FROM products WHERE id=?').run(id);
  require('./orders').audit(actor, 'product.delete', null, { id });
  return { ok: true, image: existing.image };
}

function isKnownShipping(method) {
  return Object.prototype.hasOwnProperty.call(SHIPPING, method);
}

module.exports = {
  CURRENCY, SHIPPING, TAX_RATE, MAX_QTY_PER_LINE, STATUSES, SEED_PRODUCTS,
  getProduct, getOrderable, listPublic, listAll, validate, createProduct,
  updateProduct, setStatus, deleteProduct, isKnownShipping
};
