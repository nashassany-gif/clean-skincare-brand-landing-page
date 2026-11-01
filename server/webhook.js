'use strict';
const payments=require('./payments');
const store=require('./store');
const orders=require('./orders');
const {db}=require('./database');
function recordFailure(kind,err){
  const status=Number(err.status)||400,code=status===409?'binding_rejected':'verification_or_processing_failed';
  // Never log signed bodies, contact data, tokens, keys or attacker-controlled messages.
  try{db.prepare('INSERT INTO webhook_failures(kind,status,code,created_at) VALUES(?,?,?,?)').run(kind,status,code,store.now());}catch(_){}
  console.error(JSON.stringify({type:'webhook_failure',kind,status,code}));
}
function handlePaymentNotification(rawBody,headers){
  if(!payments.enabled())return{status:503,body:{ok:false,code:'PAYMENT_DISABLED',message:'WeChat Pay is not enabled.'}};
  try{
    const result=store.transaction(()=>{
      const verified=payments.handlePaymentNotification({rawBody:rawBody.toString('utf8'),headers},n=>store.getOrder(n,false));
      if(!verified.accepted)return{status:200,body:{code:'SUCCESS',message:'Ignored non-success event.'}};
      if(db.prepare('SELECT id FROM payment_events WHERE id=?').get(verified.eventId))return{status:200,body:{code:'SUCCESS',message:'Duplicate acknowledged.'}};
      const applied=orders.applyVerifiedPayment(verified.orderNumber,verified);
      if(!applied.ok)throw Object.assign(new Error(applied.message||'Order state or binding rejected.'),{status:applied.status||409});
      // A success for an order that can no longer be fulfilled is still money we received.
      // It is recorded as 'paid_unallocated' (never dropped, never marked shippable) so an
      // operator can refund or adopt it. We acknowledge with 200 either way: returning an
      // error would make WeChat Pay retry forever without changing the outcome.
      db.prepare('INSERT INTO payment_events(id,order_number,event_type,verified,result,created_at) VALUES(?,?,?,?,?,?)').run(verified.eventId,verified.orderNumber,'TRANSACTION.SUCCESS',1,applied.unallocated?'unallocated':'applied',store.now());
      return{status:200,body:{code:'SUCCESS',message:applied.unallocated?'成功（订单已关闭，待人工处理）':'成功'}};
    });return result;
  }catch(err){recordFailure('payment',err);return{status:err.status||400,body:{code:'FAIL',message:err.status===409?'Order binding rejected.':'Invalid payment notification.'}};}
}

/**
 * Refund notification. Same fail-closed and idempotency rules as the payment webhook.
 * A refund that fails to apply must not be acknowledged as success.
 */
function handleRefundNotification(rawBody,headers){
  if(!payments.enabled())return{status:503,body:{ok:false,code:'PAYMENT_DISABLED',message:'WeChat Pay is not enabled.'}};
  try{
    return store.transaction(()=>{
      const verified=payments.handleRefundNotification({rawBody:rawBody.toString('utf8'),headers});
      if(!verified.accepted)return{status:200,body:{code:'SUCCESS',message:'Ignored non-refund event.'}};
      if(db.prepare('SELECT id FROM payment_events WHERE id=?').get(verified.eventId))return{status:200,body:{code:'SUCCESS',message:'Duplicate acknowledged.'}};
      const refund=db.prepare('SELECT * FROM refunds WHERE id=?').get(verified.refundId);
      if(!refund)throw Object.assign(new Error('Unknown refund id.'),{status:409});
      const order=store.getOrder(refund.order_number,false);
      // Bind the decrypted provider payload to our refund ledger before recording it.
      // This prevents a valid but unrelated callback from changing another order's refund.
      if(verified.orderNumber!==refund.order_number||
         verified.amountCents!==refund.amount_cents||
         verified.totalCents!==order.totalCents||
         verified.currency!==order.currency)throw Object.assign(new Error('Refund notification does not match the local refund.'),{status:409});
      const applied=orders.applyRefundResult(refund.order_number,{id:verified.refundId,status:verified.status,providerRefundId:verified.providerRefundId,raw:{out_refund_no:verified.refundId,out_trade_no:verified.orderNumber,amount:{refund:verified.amountCents,total:verified.totalCents,currency:verified.currency}}});
      if(!applied.ok)throw Object.assign(new Error(applied.message||'Refund rejected.'),{status:applied.status||409});
      db.prepare('INSERT INTO payment_events(id,order_number,event_type,verified,result,created_at) VALUES(?,?,?,?,?,?)').run(verified.eventId,refund.order_number,'REFUND.'+(verified.status||'').toUpperCase(),1,verified.status,store.now());
      return{status:200,body:{code:'SUCCESS',message:'成功'}};
    });
  }catch(err){recordFailure('refund',err);return{status:err.status||400,body:{code:'FAIL',message:err.status===409?'Refund binding rejected.':'Invalid refund notification.'}};}
}
module.exports={handlePaymentNotification,handleRefundNotification};
