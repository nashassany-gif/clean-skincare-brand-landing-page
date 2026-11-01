'use strict';
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const catalog = require('./catalog');

const DATA_DIR = process.env.LOAM_DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_FILE = process.env.LOAM_DB_FILE || path.join(DATA_DIR, 'loam.sqlite');
const db = new DatabaseSync(DB_FILE);
db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;');

const migrations = [
  { version: 1, sql: `
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS products (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, size TEXT NOT NULL,
      price_cents INTEGER NOT NULL CHECK(price_cents >= 0),
      stock INTEGER NOT NULL CHECK(stock >= 0)
    );
    CREATE TABLE IF NOT EXISTS orders (
      number TEXT PRIMARY KEY, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      expires_at TEXT, currency TEXT NOT NULL, subtotal_cents INTEGER NOT NULL,
      shipping_cents INTEGER NOT NULL, tax_cents INTEGER NOT NULL, total_cents INTEGER NOT NULL,
      shipping_method TEXT NOT NULL, tax_rate REAL NOT NULL, customer_json TEXT NOT NULL,
      token_hash TEXT NOT NULL, token_ciphertext TEXT NOT NULL, payment_status TEXT NOT NULL, fulfillment_status TEXT NOT NULL,
      provider TEXT NOT NULL, payment_intent_id TEXT, provider_transaction_id TEXT,
      stock_released INTEGER NOT NULL DEFAULT 0, refunded_cents INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS order_items (
      order_number TEXT NOT NULL REFERENCES orders(number) ON DELETE CASCADE,
      product_id TEXT NOT NULL, name TEXT NOT NULL, size TEXT NOT NULL,
      qty INTEGER NOT NULL CHECK(qty > 0), unit_price_cents INTEGER NOT NULL,
      line_total_cents INTEGER NOT NULL, PRIMARY KEY(order_number, product_id)
    );
    CREATE TABLE IF NOT EXISTS stock_ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT, order_number TEXT NOT NULL REFERENCES orders(number),
      product_id TEXT NOT NULL, qty INTEGER NOT NULL, action TEXT NOT NULL,
      created_at TEXT NOT NULL, UNIQUE(order_number, product_id, action)
    );
    CREATE TABLE IF NOT EXISTS idempotency (
      key TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, order_number TEXT NOT NULL REFERENCES orders(number),
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS payment_events (
      id TEXT PRIMARY KEY, order_number TEXT, event_type TEXT NOT NULL, verified INTEGER NOT NULL,
      result TEXT NOT NULL, payload_json TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS order_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, order_number TEXT NOT NULL REFERENCES orders(number),
      event_type TEXT NOT NULL, detail_json TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS admins (
      id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL, created_at TEXT NOT NULL, disabled INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY, admin_id INTEGER NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
      csrf_token TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, actor TEXT NOT NULL, action TEXT NOT NULL,
      order_number TEXT, detail_json TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS newsletter (email TEXT PRIMARY KEY, created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_orders_payment ON orders(payment_status);
    CREATE INDEX IF NOT EXISTS idx_orders_fulfillment ON orders(fulfillment_status);
    CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);
  ` },
  { version: 2, sql: `
    CREATE TABLE IF NOT EXISTS refunds (
      id TEXT PRIMARY KEY,
      order_number TEXT NOT NULL REFERENCES orders(number),
      amount_cents INTEGER NOT NULL CHECK(amount_cents > 0),
      status TEXT NOT NULL,
      provider_refund_id TEXT,
      reason TEXT,
      raw_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_refunds_order ON refunds(order_number);
    CREATE INDEX IF NOT EXISTS idx_ledger_product ON stock_ledger(product_id);
  ` },
  { version: 3, sql: `
    CREATE TABLE IF NOT EXISTS payment_intents (
      order_number TEXT PRIMARY KEY REFERENCES orders(number) ON DELETE CASCADE,
      provider TEXT NOT NULL,
      payment_url TEXT,
      response_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT
    );
  ` },
  { version: 4, sql: `
    CREATE TABLE IF NOT EXISTS rate_limits (
      key TEXT PRIMARY KEY, count INTEGER NOT NULL, reset_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_rate_reset ON rate_limits(reset_at);
    ALTER TABLE sessions ADD COLUMN last_seen_at TEXT;
    UPDATE sessions SET last_seen_at=created_at;
  ` },
  { version: 5, sql: `
    ALTER TABLE admins ADD COLUMN role TEXT NOT NULL DEFAULT 'owner' CHECK(role IN ('owner','ops','viewer'));
    ALTER TABLE sessions ADD COLUMN reauthenticated_at TEXT;
  ` },
  { version: 6, sql: `
    CREATE TABLE IF NOT EXISTS webhook_failures (id INTEGER PRIMARY KEY, kind TEXT NOT NULL, status INTEGER NOT NULL, code TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_webhook_failures_created ON webhook_failures(created_at);
  ` }
];

/**
 * Run `fn` inside a transaction. Re-entrant.
 *
 * The outermost call opens a real `BEGIN IMMEDIATE` (single writer). Nested calls
 * open a SAVEPOINT instead, so a business function may safely call another
 * business function that also wraps itself in `transaction()`. Without this, any
 * such composition throws `cannot start a transaction within a transaction` and
 * silently breaks the whole operation (this was the cause of the payment-webhook
 * and admin-cancel defects).
 *
 * `fn` must be synchronous: node:sqlite's DatabaseSync cannot interleave an
 * await with an open transaction.
 */
let depth = 0;
let savepointSeq = 0;

function transaction(fn) {
  const outermost = depth === 0;
  const savepoint = `loam_sp_${++savepointSeq}`;

  if (outermost) db.exec('BEGIN IMMEDIATE');
  else db.exec(`SAVEPOINT ${savepoint}`);

  depth += 1;
  try {
    const result = fn();
    if (outermost) db.exec('COMMIT');
    else db.exec(`RELEASE ${savepoint}`);
    return result;
  } catch (err) {
    if (outermost) {
      try { db.exec('ROLLBACK'); } catch (_) {}
    } else {
      try { db.exec(`ROLLBACK TO ${savepoint}`); db.exec(`RELEASE ${savepoint}`); } catch (_) {}
    }
    throw err;
  } finally {
    depth -= 1;
  }
}

/** True while a transaction is open on this connection. Used by tests. */
function inTransaction() { return depth > 0; }

function migrate() {
  transaction(() => {
    db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
    const applied = new Set(db.prepare('SELECT version FROM schema_migrations').all().map(r => r.version));
    for (const m of migrations) {
      if (applied.has(m.version)) continue;
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_migrations VALUES (?, ?)').run(m.version, new Date().toISOString());
    }
    const columns = db.prepare('PRAGMA table_info(orders)').all().map(c => c.name);
    if (!columns.includes('token_ciphertext')) db.exec("ALTER TABLE orders ADD COLUMN token_ciphertext TEXT NOT NULL DEFAULT ''");
    const insert = db.prepare('INSERT INTO products VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING');
    for (const id of catalog.ORDER) {
      const p = catalog.getProduct(id);
      insert.run(id, p.name, p.size, p.priceCents, p.stock);
    }
  });
}
migrate();

function close() { db.close(); }
module.exports = { db, DB_FILE, DATA_DIR, transaction, inTransaction, close, migrate };
