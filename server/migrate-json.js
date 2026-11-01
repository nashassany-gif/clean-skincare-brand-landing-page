'use strict';
/**
 * One-way, re-runnable import of the legacy data/store.json into SQLite.
 *
 * Legacy orders were created by the mock payment provider and no real money was
 * ever collected, so a legacy "demo_paid" is imported as payment_status='unpaid'
 * — never 'paid'. The original status/provider is preserved in a 'legacy.imported'
 * order event for auditability. Stock reservations are preserved as-is
 * (expires_at stays NULL so the sweeper will never silently reclaim them;
 * an admin can cancel the order to release stock deliberately).
 * Legacy idempotency keys and newsletter rows are not imported (documented).
 */
const fs=require('fs');
const path=require('path');
const crypto=require('crypto');
const {db,transaction,DB_FILE,DATA_DIR}=require('./database');
const file=process.argv[2];
if(!file)throw new Error('Usage: node server/migrate-json.js /secure/backup/store.json');
const input=JSON.parse(fs.readFileSync(path.resolve(file),'utf8'));
const result=transaction(()=>{
  let imported=0,skipped=0,total=0;
  for(const [number,o] of Object.entries(input.orders||{})){
    if(db.prepare('SELECT number FROM orders WHERE number=?').get(number)){skipped++;continue;}
    if(!/^LOAM-\d{8}-\d{5}$/.test(number)||o.number!==number||!Number.isSafeInteger(o.totalCents)||!Array.isArray(o.items)){
      throw new Error('Invalid legacy order: '+number);
    }
    // Never map any legacy state to 'paid': the legacy provider was a mock.
    const cancelled=o.status==='cancelled';
    const paymentStatus=cancelled?'failed':'unpaid';
    const fulfillmentStatus=cancelled?'cancelled':'pending';
    db.prepare(`INSERT INTO orders(number,created_at,updated_at,expires_at,currency,subtotal_cents,shipping_cents,tax_cents,total_cents,shipping_method,tax_rate,customer_json,token_hash,token_ciphertext,payment_status,fulfillment_status,provider,payment_intent_id,stock_released,refunded_cents)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      number,o.createdAt,o.createdAt,null,o.currency,o.subtotalCents,o.shippingCents,o.taxCents,o.totalCents,
      o.shipping,o.taxRate,JSON.stringify(o.customer),
      crypto.createHash('sha256').update(String(o.accessToken||crypto.randomBytes(32))).digest('hex'),
      '',paymentStatus,fulfillmentStatus,'legacy-json',o.paymentIntentId||null,o.stockReleased?1:0,o.refundedCents||0);
    for(const i of o.items){
      db.prepare('INSERT INTO order_items VALUES(?,?,?,?,?,?,?)').run(number,i.id,i.name,i.size,i.qty,i.unitPriceCents,i.lineTotalCents);
      db.prepare("INSERT INTO stock_ledger(order_number,product_id,qty,action,created_at) VALUES(?,?,?,'reserve',?)").run(number,i.id,i.qty,o.createdAt);
      if(o.stockReleased)db.prepare("INSERT INTO stock_ledger(order_number,product_id,qty,action,created_at) VALUES(?,?,?,'release',?)").run(number,i.id,i.qty,o.createdAt);
    }
    db.prepare('INSERT INTO order_events(order_number,event_type,detail_json,created_at) VALUES(?,?,?,?)').run(
      number,'legacy.imported',JSON.stringify({from:'json-store',originalStatus:o.status,originalPaymentStatus:o.paymentStatus,originalProvider:o.provider,paymentIntentId:o.paymentIntentId||null,note:'Imported from JSON store; no real payment was ever collected.'}),o.createdAt);
    for(const e of (o.events||[]))db.prepare('INSERT INTO order_events(order_number,event_type,detail_json,created_at) VALUES(?,?,?,?)').run(number,e.type,e.detail?JSON.stringify(e.detail):null,e.at);
    imported++;total+=o.totalCents;
  }
  return{imported,skipped,totalCents:total,newsletterNotImported:(input.newsletter||[]).length,idempotencyNotImported:Object.keys(input.idempotency||{}).length};
});
console.log(JSON.stringify({database:DB_FILE,dataDir:DATA_DIR,...result,integrity:db.prepare('PRAGMA integrity_check').get()}));
