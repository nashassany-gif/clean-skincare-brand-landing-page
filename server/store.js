'use strict';
/** Relational persistence. Compatibility helpers only; business writes are transactional in orders.js. */
const crypto = require('crypto');
const { db, DB_FILE, DATA_DIR, transaction, close } = require('./database');
const hash = value => crypto.createHash('sha256').update(String(value)).digest('hex');
const now = () => new Date().toISOString();
const parse = value => JSON.parse(value || '{}');
const moneyFields = ['subtotal_cents','shipping_cents','tax_cents','total_cents','refunded_cents'];

function hydrate(row) {
  if (!row) return null;
  const o = { ...row, customer: parse(row.customer_json), events: [] };
  const names = { subtotal_cents:'subtotalCents', shipping_cents:'shippingCents', tax_cents:'taxCents', total_cents:'totalCents', refunded_cents:'refundedCents', created_at:'createdAt', updated_at:'updatedAt', expires_at:'expiresAt', shipping_method:'shipping', tax_rate:'taxRate', token_hash:'tokenHash', payment_status:'paymentStatus', fulfillment_status:'fulfillmentStatus', payment_intent_id:'paymentIntentId', provider_transaction_id:'providerTransactionId', stock_released:'stockReleased' };
  for (const [from,to] of Object.entries(names)) { o[to] = from === 'stock_released' ? !!row[from] : row[from]; delete o[from]; }
  delete o.customer_json;
  o.status = o.fulfillmentStatus === 'cancelled' ? 'cancelled' : o.paymentStatus;
  o.itemCount = o.items.reduce((n,i)=>n+i.qty,0);
  return o;
}
function getOrder(number, withEvents = true) {
  const row = db.prepare('SELECT * FROM orders WHERE number=?').get(number);
  if (!row) return null;
  row.items = db.prepare('SELECT product_id AS id,name,size,qty,unit_price_cents AS unitPriceCents,line_total_cents AS lineTotalCents FROM order_items WHERE order_number=?').all(number);
  const o = hydrate(row);
  if (withEvents) o.events = db.prepare('SELECT event_type AS type,detail_json,created_at AS at FROM order_events WHERE order_number=? ORDER BY id').all(number).map(e=>({type:e.type,at:e.at,...(e.detail_json?{detail:parse(e.detail_json)}:{})}));
  return o;
}
function listOrders({q='',paymentStatus='',fulfillmentStatus='',from='',to='',page=1,pageSize=20,sort='newest'}={}) {
  page=Math.max(1,Math.min(10000,Number(page)||1)); pageSize=Math.max(1,Math.min(100,Number(pageSize)||20));
  const clauses=[],params=[];
  if(q){clauses.push('(number LIKE ? OR customer_json LIKE ?)');params.push(`%${q}%`,`%${q}%`);}
  for(const [field,value] of [['payment_status',paymentStatus],['fulfillment_status',fulfillmentStatus]])if(value){clauses.push(field+'=?');params.push(value);}
  if(from){clauses.push('created_at>=?');params.push(from);}
  if(to){clauses.push('created_at<=?');params.push(to);}
  const where=clauses.length?'WHERE '+clauses.join(' AND '):'';
  const total=db.prepare('SELECT COUNT(*) AS n FROM orders '+where).get(...params).n;
  const order=sort==='oldest'?'ASC':'DESC';
  const rows=db.prepare(`SELECT number FROM orders ${where} ORDER BY created_at ${order},number ${order} LIMIT ? OFFSET ?`).all(...params,pageSize,(page-1)*pageSize);
  return {orders:rows.map(r=>getOrder(r.number,false)),total,page,pageSize,pages:Math.max(1,Math.ceil(total/pageSize))};
}
function availableStock(id) {
  const p=db.prepare('SELECT stock FROM products WHERE id=?').get(id); if(!p)return 0;
  const r=db.prepare("SELECT COALESCE(SUM(CASE WHEN action='reserve' THEN qty ELSE -qty END),0) AS held FROM stock_ledger WHERE product_id=?").get(id);
  return p.stock-r.held;
}
function event(orderNumber,type,detail){db.prepare('INSERT INTO order_events(order_number,event_type,detail_json,created_at) VALUES(?,?,?,?)').run(orderNumber,type,detail?JSON.stringify(detail):null,now());}
function addNewsletter(email){const result=db.prepare('INSERT INTO newsletter VALUES(?,?) ON CONFLICT(email) DO NOTHING').run(email,now());return result.changes===0;}
function stats(){return {orders:db.prepare('SELECT COUNT(*) n FROM orders').get().n,unpaid:db.prepare("SELECT COUNT(*) n FROM orders WHERE payment_status='unpaid'").get().n,paid:db.prepare("SELECT COUNT(*) n FROM orders WHERE payment_status='paid'").get().n,toProcess:db.prepare("SELECT COUNT(*) n FROM orders WHERE fulfillment_status IN ('pending','processing')").get().n};}
function backup(destination){return require('node:sqlite').backup(db,destination);}
function reset(){transaction(()=>{for(const table of ['audit_log','sessions','admins','newsletter','payment_events','refunds','payment_intents','idempotency','stock_ledger','order_events','order_items','orders'])db.exec('DELETE FROM '+table);});}
module.exports={getOrder,listOrders,availableStock,event,addNewsletter,stats,backup,reset,transaction,hash,now,DB_FILE,DATA_DIR,close};
