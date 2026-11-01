'use strict';
const crypto = require('crypto');
const catalog = require('./catalog');
const store = require('./store');
const { db } = require('./database');
const tokens = require('./tokens');
const RESERVATION_TTL_MS = 30*60*1000;
const FULFILLMENT = ['pending','processing','shipped','completed','cancelled'];
/**
 * Payment ledger states.
 *
 *   unpaid ──(admin creates payment)──► processing ──(verified SUCCESS)──► paid
 *      │                                    │                                │
 *      │                                    └──(FAIL / CLOSED)──► failed     │
 *      └──(cancel / reservation expired)──► failed                          │
 *                                                                           │
 *   paid ──(refund requested)──► refund_pending ──(refund SUCCESS)──► partially_refunded
 *                                                                    └► refunded
 *   refund_pending ──(refund FAILED)──► paid (or partially_refunded)
 *
 *   paid_unallocated: a signature-verified success arrived for an order that can no
 *   longer be fulfilled (cancelled, or its stock reservation already expired). The
 *   customer really was charged, so the money is recorded and flagged for a human.
 *   It is deliberately NOT 'paid' (it must not ship) and NOT 'failed' (it must not
 *   look like nothing happened). See reconcileUnallocated().
 *
 * No admin action can move an order into 'paid': only a verified notification can.
 */
const PAYMENT = ['unpaid','processing','paid','failed','paid_unallocated','refund_pending','partially_refunded','refunded'];
/** States from which a verified success payment may still be fulfilled normally. */
const PAYABLE = ['unpaid','processing','failed'];
/** States in which a refund may be requested. */
const REFUNDABLE = ['paid','partially_refunded','paid_unallocated','refund_pending'];
const REFUND_STATUSES = ['pending','success','failed','closed'];

function normaliseItems(rawItems){
  if(!Array.isArray(rawItems)||!rawItems.length||rawItems.length>20)return{ok:false,message:'Your bag is empty or malformed.'};
  const merged=new Map();
  for(const raw of rawItems){
    if(!raw||typeof raw!=='object'||Array.isArray(raw))return{ok:false,message:'Malformed bag item.'};
    const id=typeof raw.id==='string'?raw.id:'';const qty=raw.qty;
    if(!catalog.getProduct(id))return{ok:false,message:`Unknown product: ${id}`};
    if(!Number.isSafeInteger(qty)||qty<1)return{ok:false,message:`Invalid quantity for ${id}.`};
    const next=(merged.get(id)||0)+qty;if(next>catalog.MAX_QTY_PER_LINE)return{ok:false,message:`You can order at most ${catalog.MAX_QTY_PER_LINE} of ${id}.`};merged.set(id,next);
  }
  return{ok:true,items:catalog.ORDER.filter(id=>merged.has(id)).map(id=>{const p=catalog.getProduct(id),qty=merged.get(id);return{id,name:p.name,size:p.size,qty,unitPriceCents:p.priceCents,lineTotalCents:p.priceCents*qty};})};
}
function priceOrder(items,shippingMethod){
  const subtotalCents=items.reduce((s,i)=>s+i.lineTotalCents,0);const method=shippingMethod==null?'standard':shippingMethod;
  if(!catalog.isKnownShipping(method))return{ok:false,message:'Unknown shipping method.'};const rule=catalog.SHIPPING[method];
  const shippingCents=rule.freeOverCents!==null&&subtotalCents>=rule.freeOverCents?0:rule.cents;
  const taxCents=Math.round(subtotalCents*catalog.TAX_RATE);
  return{ok:true,subtotalCents,shippingCents,taxCents,totalCents:subtotalCents+shippingCents+taxCents,shippingMethod:method,taxRate:catalog.TAX_RATE};
}
function sanitiseCustomer(customer){
  if(!customer||typeof customer!=='object'||Array.isArray(customer))throw Object.assign(new Error('Customer details are required.'),{status:400});
  const c={};const fields={email:254,firstName:80,lastName:80,phone:40,address:200,apt:80,city:100,region:100,postal:24,country:2};
  for(const [key,max] of Object.entries(fields)){const value=customer[key];if(value!=null&&typeof value!=='string')throw Object.assign(new Error('Invalid customer details.'),{status:400});c[key]=String(value??'').trim();if(c[key].length>max||/[\u0000-\u001f\u007f]/.test(c[key]))throw Object.assign(new Error('Invalid or excessive customer details.'),{status:400});}
  c.country=c.country.toUpperCase();
  const required=['email','firstName','lastName','address','city','region','postal','country'];
  if(required.some(k=>!c[k])||!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(c.email)||!/^[A-Z]{2}$/.test(c.country)||(c.country==='US'&&!/^\d{5}(-\d{4})?$/.test(c.postal))||(c.country!=='US'&&c.postal.length<3))throw Object.assign(new Error('Please provide complete, valid contact and shipping details.'),{status:400});
  return c;
}
function fingerprint(items,shipping,customer){return crypto.createHash('sha256').update(JSON.stringify({items:items.map(i=>[i.id,i.qty]),shipping,customer:{...customer,email:customer.email.toLowerCase()}})).digest('hex');}
function number(){for(let i=0;i<20;i++){const n=`LOAM-${new Date().toISOString().slice(0,10).replace(/-/g,'')}-${crypto.randomInt(0,100000).toString().padStart(5,'0')}`;if(!store.getOrder(n,false))return n;}throw new Error('Could not allocate order number.');}
function createOrder({items:rawItems,shipping,customer,idempotencyKey}){
  const normal=normaliseItems(rawItems);if(!normal.ok)return normal;const totals=priceOrder(normal.items,shipping);if(!totals.ok)return totals;
  if(typeof idempotencyKey!=='string'||idempotencyKey.length<16||idempotencyKey.length>200)return{ok:false,status:400,message:'A valid Idempotency-Key is required.'};
  const safe=sanitiseCustomer(customer),fp=fingerprint(normal.items,totals.shippingMethod,safe);
  return store.transaction(()=>{
    expireReservations();
    const old=db.prepare('SELECT * FROM idempotency WHERE key=?').get(idempotencyKey);
    if(old){if(old.fingerprint!==fp)return{ok:false,status:409,message:'This Idempotency-Key was already used for a different request.'};return{ok:true,replayed:true,order:store.getOrder(old.order_number),orderToken:(()=>{const row=db.prepare('SELECT token_ciphertext FROM orders WHERE number=?').get(old.order_number);return row&&row.token_ciphertext?tokens.open(row.token_ciphertext):null;})()};}
    for(const item of normal.items)if(store.availableStock(item.id)<item.qty)return{ok:false,status:409,message:`Not enough ${item.name} in stock.`};
    const n=number(),at=new Date(),token=crypto.randomBytes(32).toString('base64url');
    db.prepare(`INSERT INTO orders(number,created_at,updated_at,expires_at,currency,subtotal_cents,shipping_cents,tax_cents,total_cents,shipping_method,tax_rate,customer_json,token_hash,token_ciphertext,payment_status,fulfillment_status,provider) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(n,at.toISOString(),at.toISOString(),new Date(at.getTime()+RESERVATION_TTL_MS).toISOString(),'usd',totals.subtotalCents,totals.shippingCents,totals.taxCents,totals.totalCents,totals.shippingMethod,totals.taxRate,JSON.stringify(safe),store.hash(token),tokens.seal(token),'unpaid','pending','wechatpay');
    for(const i of normal.items){db.prepare('INSERT INTO order_items VALUES(?,?,?,?,?,?,?)').run(n,i.id,i.name,i.size,i.qty,i.unitPriceCents,i.lineTotalCents);db.prepare("INSERT INTO stock_ledger(order_number,product_id,qty,action,created_at) VALUES(?,?,?,'reserve',?)").run(n,i.id,i.qty,at.toISOString());}
    db.prepare('INSERT INTO idempotency VALUES(?,?,?,?)').run(idempotencyKey,fp,n,at.toISOString());store.event(n,'order.created');
    return{ok:true,replayed:false,order:store.getOrder(n),orderToken:token};
  });
}
function release(order,reason){if(order.stockReleased)return false;for(const i of order.items)db.prepare("INSERT INTO stock_ledger(order_number,product_id,qty,action,created_at) VALUES(?,?,?,'release',?) ON CONFLICT DO NOTHING").run(order.number,i.id,i.qty,store.now());db.prepare("UPDATE orders SET stock_released=1,expires_at=NULL,updated_at=? WHERE number=?").run(store.now(),order.number);store.event(order.number,'stock.released',{reason});return true;}
function cancel(number,reason='customer_cancelled'){return store.transaction(()=>{const o=store.getOrder(number);if(!o)return{ok:false,status:404};if(['paid','paid_unallocated','refund_pending','partially_refunded','refunded'].includes(o.paymentStatus)||['shipped','completed'].includes(o.fulfillmentStatus))return{ok:false,status:409,message:'This order can no longer be cancelled.'};if(o.fulfillmentStatus==='cancelled')return{ok:true,changed:false,order:o};release(o,reason);db.prepare("UPDATE orders SET payment_status='failed',fulfillment_status='cancelled',updated_at=? WHERE number=?").run(store.now(),number);store.event(number,'order.cancelled',{reason});return{ok:true,changed:true,order:store.getOrder(number)};});}
function expireReservations(nowMs=Date.now()){
  return store.transaction(()=>{
  const expired=db.prepare("SELECT number FROM orders WHERE fulfillment_status!='cancelled' AND stock_released=0 AND payment_status IN ('unpaid','processing','failed') AND expires_at<=?").all(new Date(nowMs).toISOString());
  for(const {number:n} of expired){const o=store.getOrder(n);release(o,'reservation_expired');db.prepare("UPDATE orders SET payment_status='failed',fulfillment_status='cancelled',updated_at=? WHERE number=?").run(store.now(),n);store.event(n,'order.reservation_expired');}return expired.map(x=>x.number);
  });
}
function updateFulfillment(number,status,actor){if(!FULFILLMENT.includes(status))return{ok:false,status:400,message:'Invalid fulfilment status.'};return store.transaction(()=>{const o=store.getOrder(number);if(!o)return{ok:false,status:404};if(['shipped','completed'].includes(status)&&o.paymentStatus!=='paid')return{ok:false,status:409,message:'An unpaid order cannot be shipped or completed.'};if(status==='cancelled'){const r=cancel(number,'admin_cancelled');if(r.ok)audit(actor,'order.cancel',number);return r;}if(o.fulfillmentStatus==='cancelled')return{ok:false,status:409,message:'Cancelled orders cannot be reopened.'};db.prepare('UPDATE orders SET fulfillment_status=?,updated_at=? WHERE number=?').run(status,store.now(),number);store.event(number,'fulfilment.updated',{from:o.fulfillmentStatus,to:status});audit(actor,'fulfilment.update',number,{from:o.fulfillmentStatus,to:status});return{ok:true,order:store.getOrder(number)};});}
function audit(actor,action,number,detail){db.prepare('INSERT INTO audit_log(actor,action,order_number,detail_json,created_at) VALUES(?,?,?,?,?)').run(actor,action,number||null,detail?JSON.stringify(detail):null,store.now());}
function canAccessOrder(order,token){if(!order||typeof token!=='string')return false;const a=Buffer.from(order.tokenHash),b=Buffer.from(store.hash(token));return a.length===b.length&&crypto.timingSafeEqual(a,b);}
function publicOrder(o){
  const ready=require('./payments').readiness(o);
  const messages={paid:'Payment verified by the server.',paid_unallocated:'Payment received; this closed order requires operator review.',refund_pending:'Refund is pending confirmation.',partially_refunded:'Payment has been partially refunded.',refunded:'Payment has been refunded.'};
  return{number:o.number,createdAt:o.createdAt,updatedAt:o.updatedAt,expiresAt:o.expiresAt,itemCount:o.itemCount,items:o.items,subtotal:o.subtotalCents/100,shippingCost:o.shippingCents/100,tax:o.taxCents/100,total:o.totalCents/100,shipping:o.shipping,taxRate:o.taxRate,currency:o.currency,status:o.status,paymentStatus:o.paymentStatus,fulfillmentStatus:o.fulfillmentStatus,stockReleased:o.stockReleased,customer:o.customer,refunded:o.refundedCents/100,paymentEnabled:ready.ok,paymentMessage:messages[o.paymentStatus]||(ready.ok?'Payment has not yet been verified.':ready.message)};
}

/**
 * Mark an order as processing while a payment is being created with the provider.
 * Safe to call repeatedly; a paid order is never moved backwards.
 */
function beginPayment(number,actor){
  return store.transaction(()=>{
    const o=store.getOrder(number);
    if(!o)return{ok:false,status:404,message:'Order not found.'};
    if(o.paymentStatus==='paid')return{ok:true,changed:false,order:o};
    if(!PAYABLE.includes(o.paymentStatus))return{ok:false,status:409,message:`This order is ${o.paymentStatus} and cannot be paid.`};
    if(o.fulfillmentStatus==='cancelled')return{ok:false,status:409,message:'This order was cancelled.'};
    if(o.stockReleased)return{ok:false,status:409,message:'The stock reservation for this order expired.'};
    if(o.paymentStatus==='processing')return{ok:true,changed:false,order:o};
    db.prepare("UPDATE orders SET payment_status='processing',updated_at=? WHERE number=? AND payment_status IN ('unpaid','failed')").run(store.now(),number);
    store.event(number,'payment.started');
    if(actor)audit(actor,'payment.start',number);
    return{ok:true,changed:true,order:store.getOrder(number)};
  });
}

/**
 * Record a payment failure reported by the provider (or by an abandoned flow).
 * Never touches a paid order.
 */
function markPaymentFailed(number,reason,actor){
  return store.transaction(()=>{
    const o=store.getOrder(number);
    if(!o)return{ok:false,status:404,message:'Order not found.'};
    if(o.paymentStatus==='paid')return{ok:true,changed:false,order:o};
    if(!['unpaid','processing'].includes(o.paymentStatus))return{ok:true,changed:false,order:o};
    db.prepare("UPDATE orders SET payment_status='failed',updated_at=? WHERE number=? AND payment_status IN ('unpaid','processing')").run(store.now(),number);
    store.event(number,'payment.failed',{reason:reason||'unknown'});
    if(actor)audit(actor,'payment.failed',number,{reason:reason||'unknown'});
    return{ok:true,changed:true,order:store.getOrder(number)};
  });
}

/**
 * Apply a signature-verified payment result.
 *
 * Binding checks (amount + currency) are fatal: a mismatched notification is rejected
 * and nothing is written, because it does not describe this order.
 *
 * A structurally valid success for an order that can no longer be fulfilled is NOT
 * dropped. The customer has genuinely been charged, so the money is recorded as
 * 'paid_unallocated' and surfaced to an operator instead of being silently lost.
 */
function applyVerifiedPayment(number,notification){
  return store.transaction(()=>{
    const o=store.getOrder(number);
    if(!o)return{ok:false,status:404,message:'Order not found.'};
    if(!notification.transactionId||notification.amountCents!==o.totalCents||notification.currency!==o.currency)return{ok:false,status:409,message:'Notification transaction, amount or currency does not match this order.'};
    if(o.providerTransactionId&&o.providerTransactionId!==notification.transactionId)return{ok:false,status:409,message:'A different provider transaction is already bound to this order.'};
    if(['paid','paid_unallocated','refund_pending','partially_refunded','refunded'].includes(o.paymentStatus))return{ok:true,changed:false,alreadyRecorded:true,order:o};
    if(!['unpaid','processing','failed'].includes(o.paymentStatus))return{ok:false,status:409,message:'This order is not in a payable state.'};
    if(o.expiresAt&&Date.parse(o.expiresAt)<=Date.now())release(o,'payment_after_expiry');
    const fresh=store.getOrder(number);
    const unallocatable=fresh.fulfillmentStatus==='cancelled'||fresh.stockReleased;
    if(unallocatable){
      db.prepare("UPDATE orders SET payment_status='paid_unallocated',fulfillment_status='cancelled',provider_transaction_id=?,updated_at=? WHERE number=? AND payment_status NOT IN ('paid','paid_unallocated')").run(notification.transactionId,store.now(),number);
      store.event(number,'payment.unallocated',{transactionId:notification.transactionId,reason:o.fulfillmentStatus==='cancelled'?'order_cancelled':'reservation_expired',amountCents:notification.amountCents});
      return{ok:true,changed:true,unallocated:true,order:store.getOrder(number)};
    }
    db.prepare("UPDATE orders SET payment_status='paid',fulfillment_status='pending',provider_transaction_id=?,expires_at=NULL,updated_at=? WHERE number=? AND payment_status NOT IN ('paid','paid_unallocated')").run(notification.transactionId,store.now(),number);
    store.event(number,'order.paid',{transactionId:notification.transactionId});
    return{ok:true,changed:true,order:store.getOrder(number)};
  });
}

/**
 * Operator decision for a charge that could not be attached to a live order:
 * either refund it in full, or adopt it back into a shippable order.
 */
function reconcileUnallocated(number,action,actor){
  if(!['refund','adopt'].includes(action))return{ok:false,status:400,message:"action must be 'refund' or 'adopt'."};
  return store.transaction(()=>{
    const o=store.getOrder(number);
    if(!o)return{ok:false,status:404,message:'Order not found.'};
    if(o.paymentStatus!=='paid_unallocated')return{ok:false,status:409,message:'This order has no unallocated payment.'};
    if(action==='adopt'){
      // Only possible when the stock was never handed back to other shoppers.
      if(o.stockReleased)return{ok:false,status:409,message:'The stock reservation was already released; refund instead of adopting.'};
      db.prepare("UPDATE orders SET payment_status='paid',fulfillment_status='pending',expires_at=NULL,updated_at=? WHERE number=? AND payment_status='paid_unallocated'").run(store.now(),number);
      store.event(number,'payment.adopted');
      audit(actor,'payment.adopt',number);
      return{ok:true,changed:true,order:store.getOrder(number)};
    }
    audit(actor,'payment.refund_requested',number,{amountCents:o.totalCents-o.refundedCents});
    return{ok:true,changed:false,needsRefund:true,amountCents:o.totalCents-o.refundedCents,order:o};
  });
}

/** Sum of refunds that actually succeeded for an order. */
function refundedTotal(number){
  return db.prepare("SELECT COALESCE(SUM(amount_cents),0) AS n FROM refunds WHERE order_number=? AND status='success'").get(number).n;
}

/** Create (or replay) a refund record. Enforces the captured-amount ceiling. */
function createRefund(number,{id,amountCents,reason,actor}={}){
  return store.transaction(()=>{
    const o=store.getOrder(number);
    if(!o)return{ok:false,status:404,message:'Order not found.'};
    if(typeof id!=='string'||!/^[A-Za-z0-9_-]{1,64}$/.test(id))return{ok:false,status:400,message:'A safe refund id (1–64 characters) is required.'};
    const existing=db.prepare('SELECT * FROM refunds WHERE id=?').get(id);
    if(existing){
      if(existing.order_number!==number)return{ok:false,status:409,message:'This refund id belongs to another order.'};
      if(existing.amount_cents!==amountCents)return{ok:false,status:409,message:'This refund id was already used for a different amount.'};
      return{ok:true,replayed:true,refund:existing};
    }
    if(!Number.isSafeInteger(amountCents)||amountCents<1)return{ok:false,status:400,message:'A positive integer refund amount is required.'};
    if(!REFUNDABLE.includes(o.paymentStatus))return{ok:false,status:409,message:`A ${o.paymentStatus} order cannot be refunded.`};
    // Pending refunds reserve part of the captured balance too. Without including them,
    // two concurrent pending requests could each pass the limit and over-refund.
    const committed=refundedTotal(number);
    const reserved=db.prepare("SELECT COALESCE(SUM(amount_cents),0) AS n FROM refunds WHERE order_number=? AND status='pending'").get(number).n;
    const captured=Math.max(0,o.totalCents-committed-reserved);
    if(amountCents>captured)return{ok:false,status:409,message:`Refund exceeds the remaining refundable amount (${captured} cents).`};
    const now=store.now();
    db.prepare('INSERT INTO refunds(id,order_number,amount_cents,status,reason,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(id,number,amountCents,'pending',reason||null,now,now);
    db.prepare("UPDATE orders SET payment_status='refund_pending',updated_at=? WHERE number=?").run(now,number);
    store.event(number,'refund.requested',{refundId:id,amountCents});
    audit(actor,'refund.request',number,{refundId:id,amountCents});
    return{ok:true,created:true,refund:db.prepare('SELECT * FROM refunds WHERE id=?').get(id)};
  });
}

/**
 * Apply a refund outcome (from the provider response or its notification).
 * Idempotent: a refund already in a terminal state is not re-applied.
 */
function applyRefundResult(number,{id,status,providerRefundId,raw}={}){
  if(!REFUND_STATUSES.includes(status))return{ok:false,status:400,message:'Invalid refund status.'};
  return store.transaction(()=>{
    const o=store.getOrder(number);
    if(!o)return{ok:false,status:404,message:'Order not found.'};
    const refund=db.prepare('SELECT * FROM refunds WHERE id=? AND order_number=?').get(id,number);
    if(!refund)return{ok:false,status:404,message:'Refund not found.'};
    if(raw&&(raw.out_refund_no!==id||raw.out_trade_no!==number||raw.amount?.refund!==refund.amount_cents||raw.amount?.total!==o.totalCents||String(raw.amount?.currency||'').toLowerCase()!==o.currency))return{ok:false,status:409,message:'Provider refund result binding mismatch.'};
    if(refund.status===status)return{ok:true,changed:false,order:o,refund};
    if(['success','closed','failed'].includes(refund.status))return{ok:true,changed:false,order:o,refund};
    const now=store.now();
    db.prepare('UPDATE refunds SET status=?,provider_refund_id=?,raw_json=?,updated_at=? WHERE id=?').run(status,providerRefundId||refund.provider_refund_id||null,raw?JSON.stringify(raw):refund.raw_json,now,id);
    if(status==='success'){
      const total=refundedTotal(number);
      const pending=db.prepare("SELECT COUNT(*) n FROM refunds WHERE order_number=? AND status='pending'").get(number).n;
      db.prepare('UPDATE orders SET refunded_cents=?,updated_at=? WHERE number=?').run(total,now,number);
      const next=pending>0?'refund_pending':(total>=o.totalCents?'refunded':'partially_refunded');
      db.prepare('UPDATE orders SET payment_status=?,updated_at=? WHERE number=?').run(next,now,number);
      store.event(number,'refund.succeeded',{refundId:id,amountCents:refund.amount_cents,refundedCents:total});
      if(total>=o.totalCents&&!['shipped','completed'].includes(o.fulfillmentStatus)){release(o,'fully_refunded_before_shipment');db.prepare("UPDATE orders SET fulfillment_status='cancelled' WHERE number=?").run(number);}
    }else if(status==='failed'||status==='closed'){
      const remaining=db.prepare("SELECT COUNT(*) n FROM refunds WHERE order_number=? AND status='pending'").get(number).n;
      if(remaining===0){
        const total=refundedTotal(number);
        const wasUnallocated=o.paymentStatus==='paid_unallocated'||o.stockReleased||o.fulfillmentStatus==='cancelled';
        const next=total>0?'partially_refunded':(wasUnallocated?'paid_unallocated':'paid');
        db.prepare('UPDATE orders SET payment_status=?,updated_at=? WHERE number=?').run(next,now,number);
      }
      store.event(number,'refund.failed',{refundId:id,status});
    }
    return{ok:true,changed:true,order:store.getOrder(number),refund:db.prepare('SELECT * FROM refunds WHERE id=?').get(id)};
  });
}

/**
 * Apply a provider trade state discovered by polling (e.g. CLOSED / PAYERROR).
 * Cannot itself mark an order paid: SUCCESS uses applyVerifiedPayment after signed query/notification verification.
 */
function applyTradeState(number,targetState,providerResponse,actor){
  if(targetState!=='failed'&&targetState!=='processing')return{ok:false,status:400,message:'Unsupported trade state transition.'};
  return store.transaction(()=>{
    const o=store.getOrder(number);
    if(!o)return{ok:false,status:404,message:'Order not found.'};
    if(!['unpaid','processing','failed'].includes(o.paymentStatus))return{ok:true,changed:false,order:o};
    if(targetState==='processing'){
      if(o.paymentStatus==='processing')return{ok:true,changed:false,order:o};
      db.prepare("UPDATE orders SET payment_status='processing',updated_at=? WHERE number=? AND payment_status IN ('unpaid','failed')").run(store.now(),number);
      store.event(number,'payment.started',{source:'provider_query'});
      return{ok:true,changed:true,order:store.getOrder(number)};
    }
    db.prepare("UPDATE orders SET payment_status='failed',updated_at=? WHERE number=? AND payment_status IN ('unpaid','processing')").run(store.now(),number);
    store.event(number,'payment.failed',{source:'provider_query',tradeState:providerResponse&&providerResponse.trade_state});
    if(actor)audit(actor,'payment.failed',number,{tradeState:providerResponse&&providerResponse.trade_state});
    return{ok:true,changed:true,order:store.getOrder(number)};
  });
}

/** Orders holding money that is not attached to a shippable order. */
function unallocatedOrders(){return db.prepare("SELECT * FROM orders WHERE payment_status='paid_unallocated' ORDER BY updated_at DESC").all().map(r=>store.getOrder(r.number,false));}
function pendingRefunds(){return db.prepare("SELECT * FROM refunds WHERE status='pending' ORDER BY created_at DESC").all();}
function listRefunds(number){return db.prepare('SELECT * FROM refunds WHERE order_number=? ORDER BY created_at DESC').all(number);}

module.exports={RESERVATION_TTL_MS,FULFILLMENT,PAYMENT,PAYABLE,REFUNDABLE,REFUND_STATUSES,normaliseItems,priceOrder,sanitiseCustomer,createOrder,cancel,expireReservations,updateFulfillment,canAccessOrder,publicOrder,beginPayment,markPaymentFailed,applyVerifiedPayment,applyTradeState,reconcileUnallocated,createRefund,applyRefundResult,refundedTotal,unallocatedOrders,pendingRefunds,listRefunds,audit};
