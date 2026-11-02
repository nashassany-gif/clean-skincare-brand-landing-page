'use strict';
/** WeChat Pay merchant API v3 adapter. Disabled by default; no development success state exists. */
const crypto=require('crypto');
const fs=require('fs');
const enabled=()=>process.env.WECHAT_PAY_ENABLED==='true';
let cachedSecrets=null;
function secrets(){if(cachedSecrets)return cachedSecrets;const read=file=>file?fs.readFileSync(file,'utf8'):'';cachedSecrets={privateKey:process.env.WECHAT_PAY_PRIVATE_KEY||read(process.env.WECHAT_PAY_PRIVATE_KEY_FILE||''),publicKey:process.env.WECHAT_PAY_PUBLIC_KEY||read(process.env.WECHAT_PAY_PUBLIC_KEY_FILE||'')};return cachedSecrets;}
function config(){const s=secrets();return{appId:process.env.WECHAT_PAY_APP_ID,mchId:process.env.WECHAT_PAY_MCH_ID,serial:process.env.WECHAT_PAY_SERIAL_NUMBER,privateKey:s.privateKey,apiV3Key:process.env.WECHAT_PAY_APIV3_KEY,publicKey:s.publicKey,publicKeyId:process.env.WECHAT_PAY_PUBLIC_KEY_ID,notifyUrl:process.env.WECHAT_PAY_NOTIFY_URL,refundNotifyUrl:process.env.WECHAT_PAY_REFUND_NOTIFY_URL,product:process.env.WECHAT_PAY_PRODUCT_TYPE,currency:process.env.WECHAT_PAY_CURRENCY};}
function unavailable(){const e=new Error('WeChat Pay is not enabled. The order remains unpaid.');e.status=503;e.code='payment_unavailable';return e;}
function ready(order){if(!enabled())throw unavailable();const c=config();for(const [k,v]of Object.entries(c))if(!v)throw Object.assign(new Error('WeChat Pay credentials/configuration are incomplete (including a dedicated refund callback).'),{status:503});if(c.notifyUrl===c.refundNotifyUrl||!/^https:\/\//.test(c.notifyUrl)||!/^https:\/\//.test(c.refundNotifyUrl)||Buffer.byteLength(c.apiV3Key)!==32)throw Object.assign(new Error('HTTPS callback URLs must be distinct and the API v3 key must be 32 bytes.'),{status:503});try{const privateKey=crypto.createPrivateKey(c.privateKey),publicKey=crypto.createPublicKey(c.publicKey);if(privateKey.asymmetricKeyType!=='rsa'||publicKey.asymmetricKeyType!=='rsa')throw new Error('RSA required.');}catch(_){throw Object.assign(new Error('Invalid WeChat Pay RSA key configuration.'),{status:503});}if(c.product!=='native'||process.env.WECHAT_PAY_CURRENCY_REVIEWED!=='true'||c.currency!==order.currency)throw Object.assign(new Error('Only the reviewed Native product/currency configuration is supported.'),{status:503});if(process.env.LOAM_LIVE_APPROVED!=='true')throw Object.assign(new Error('Live commerce is blocked pending product, tax, policy and payment acceptance review.'),{status:503});return c;}
/**
 * Non-throwing readiness probe. Callers must use this *before* changing any order
 * state: if we never contacted the provider, the order was not attempted and must
 * not be marked failed.
 */
function readiness(order){try{ready(order);return{ok:true};}catch(err){return{ok:false,status:err.status||503,code:err.code||'payment_unavailable',message:err.message};}}
function signature(method,url,timestamp,nonce,body,c){return crypto.sign('RSA-SHA256',Buffer.from(`${method}\n${url}\n${timestamp}\n${nonce}\n${body}\n`),c.privateKey).toString('base64');}
function verifyEnvelope(rawBody,headers,c=config()){
  const get=name=>typeof headers.get==='function'?headers.get(name):headers[name];
  const ts=String(get('wechatpay-timestamp')||''),nonce=String(get('wechatpay-nonce')||''),serial=String(get('wechatpay-serial')||''),sig=String(get('wechatpay-signature')||'');
  if(!/^\d+$/.test(ts)||Math.abs(Date.now()/1000-Number(ts))>300||serial!==c.publicKeyId||!nonce||!sig||!crypto.verify('RSA-SHA256',Buffer.from(`${ts}\n${nonce}\n${rawBody}\n`),c.publicKey,Buffer.from(sig,'base64')))throw Object.assign(new Error('Invalid WeChat Pay response signature.'),{status:502});
}
async function request(method,pathname,body,order){
  const c=ready(order),ts=Math.floor(Date.now()/1000).toString(),nonce=crypto.randomBytes(16).toString('hex'),raw=body?JSON.stringify(body):'',path=pathname+(method==='GET'&&body?'?'+new URLSearchParams(body):'');
  const auth=`WECHATPAY2-SHA256-RSA2048 mchid="${c.mchId}",nonce_str="${nonce}",timestamp="${ts}",serial_no="${c.serial}",signature="${signature(method,path,ts,nonce,method==='GET'?'':raw,c)}"`;
  const response=await fetch('https://api.mch.weixin.qq.com'+path,{method,headers:{Authorization:auth,Accept:'application/json',...(raw?{'Content-Type':'application/json'}:{})},body:method==='GET'?undefined:raw,signal:AbortSignal.timeout(10000)});
  const text=await response.text();
  // 204 No Content (e.g. a successful close) carries no body to verify.
  if(response.status===204)return{};
  verifyEnvelope(text,response.headers,c);
  const data=JSON.parse(text);
  if(!response.ok)throw Object.assign(new Error('WeChat Pay request failed.'),{status:502,code:data.code});
  return data;
}
function formatWeChatTime(iso){const d=new Date(iso);if(isNaN(d.getTime()))return undefined;const t=new Date(d.getTime()+8*3600*1000),p=n=>String(n).padStart(2,'0');return `${t.getUTCFullYear()}-${p(t.getUTCMonth()+1)}-${p(t.getUTCDate())}T${p(t.getUTCHours())}:${p(t.getUTCMinutes())}:${p(t.getUTCSeconds())}+08:00`;}
function createPayment(order){return ready(order)&&request('POST',`/v3/pay/transactions/${config().product==='jsapi'?'jsapi':config().product==='h5'?'h5':'native'}`,{appid:config().appId,mchid:config().mchId,description:`loam order ${order.number}`,out_trade_no:order.number,notify_url:config().notifyUrl,time_expire:formatWeChatTime(order.expiresAt),amount:{total:order.totalCents,currency:order.currency.toUpperCase()}},order);}
function closePayment(order){return request('POST','/v3/pay/transactions/out-trade-no/'+encodeURIComponent(order.number)+'/close',{mchid:config().mchId},order);}
function queryPayment(order){return request('GET','/v3/pay/transactions/out-trade-no/'+encodeURIComponent(order.number),{mchid:config().mchId},order);}
function decrypt(resource,key){const decipher=crypto.createDecipheriv('aes-256-gcm',Buffer.from(key),Buffer.from(resource.nonce,'utf8'));decipher.setAuthTag(Buffer.from(resource.ciphertext,'base64').subarray(-16));decipher.setAAD(Buffer.from(resource.associated_data||''));return JSON.parse(Buffer.concat([decipher.update(Buffer.from(resource.ciphertext,'base64').subarray(0,-16)),decipher.final()]).toString('utf8'));}
function handlePaymentNotification({rawBody,headers},orderLookup){if(!enabled())throw unavailable();const c=config();for(const k of ['appId','mchId','apiV3Key','publicKey','publicKeyId'])if(!c[k])throw unavailable();const ts=String(headers['wechatpay-timestamp']||''),nonce=String(headers['wechatpay-nonce']||''),sig=String(headers['wechatpay-signature']||''),serial=String(headers['wechatpay-serial']||'');if(!/^\d+$/.test(ts)||Math.abs(Date.now()/1000-Number(ts))>300||serial!==c.publicKeyId)throw Object.assign(new Error('Invalid notification timestamp or key id.'),{status:400});if(!crypto.verify('RSA-SHA256',Buffer.from(`${ts}\n${nonce}\n${rawBody}\n`),c.publicKey,Buffer.from(sig,'base64')))throw Object.assign(new Error('Invalid notification signature.'),{status:400});const envelope=JSON.parse(rawBody),payload=decrypt(envelope.resource,c.apiV3Key);if(envelope.event_type!=='TRANSACTION.SUCCESS'||payload.trade_state!=='SUCCESS')return{accepted:false,reason:'not_success'};const order=orderLookup(payload.out_trade_no);if(!order||payload.mchid!==c.mchId||payload.appid!==c.appId||!payload.transaction_id||payload.amount?.total!==order.totalCents||String(payload.amount?.currency||'').toLowerCase()!==order.currency)throw Object.assign(new Error('Notification does not match this order.'),{status:409});return{accepted:true,eventId:envelope.id,orderNumber:order.number,transactionId:payload.transaction_id,amountCents:payload.amount.total,currency:order.currency};}
async function requestRefund(order,refund){const c=ready(order);if(!Number.isSafeInteger(refund.amountCents)||refund.amountCents<1||refund.amountCents>order.totalCents-order.refundedCents)return Promise.reject(Object.assign(new Error('Refund exceeds the remaining captured amount.'),{status:409}));return request('POST','/v3/refund/domestic/refunds',{out_trade_no:order.number,out_refund_no:refund.id,reason:refund.reason||'Customer refund',notify_url:c.refundNotifyUrl||c.notifyUrl,amount:{refund:refund.amountCents,total:order.totalCents,currency:order.currency.toUpperCase()}},order);}
function queryRefund(order,refundId){return request('GET','/v3/refund/domestic/refunds/'+encodeURIComponent(refundId),null,order);}

/**
 * WeChat Pay refund states -> our ledger states.
 * SUCCESS/CLOSED are terminal; ABNORMAL requires provider review and keeps the balance reserved.
 */
function mapRefundStatus(providerStatus){
  switch(String(providerStatus||'').toUpperCase()){
    case 'SUCCESS': return 'success';
    case 'PROCESSING': return 'pending';
    case 'CLOSED': return 'closed';
    case 'ABNORMAL': return 'pending';
    default: return 'pending';
  }
}

/**
 * Verify and decrypt a refund notification (same envelope/signature scheme as payments).
 * Returns {accepted, refundId, providerRefundId, status, orderNumber} or throws.
 */
function handleRefundNotification({rawBody,headers}){
  if(!enabled())throw unavailable();
  const c=config();
  for(const k of ['appId','mchId','apiV3Key','publicKey','publicKeyId'])if(!c[k])throw unavailable();
  const ts=String(headers['wechatpay-timestamp']||''),nonce=String(headers['wechatpay-nonce']||''),sig=String(headers['wechatpay-signature']||''),serial=String(headers['wechatpay-serial']||'');
  if(!/^\d+$/.test(ts)||Math.abs(Date.now()/1000-Number(ts))>300||serial!==c.publicKeyId)throw Object.assign(new Error('Invalid notification timestamp or key id.'),{status:400});
  if(!crypto.verify('RSA-SHA256',Buffer.from(`${ts}\n${nonce}\n${rawBody}\n`),c.publicKey,Buffer.from(sig,'base64')))throw Object.assign(new Error('Invalid notification signature.'),{status:400});
  const envelope=JSON.parse(rawBody),payload=decrypt(envelope.resource,c.apiV3Key);
  if(envelope.event_type!=='REFUND.SUCCESS'&&envelope.event_type!=='REFUND.ABNORMAL'&&envelope.event_type!=='REFUND.CLOSED')return{accepted:false,reason:'not_refund_event',eventId:envelope.id};
  if(payload.mchid!==c.mchId)throw Object.assign(new Error('Refund notification mchid mismatch.'),{status:409});
  if(!payload.out_refund_no||!payload.out_trade_no||!Number.isSafeInteger(payload.amount?.refund)||!Number.isSafeInteger(payload.amount?.total)||typeof payload.amount?.currency!=='string')throw Object.assign(new Error('Refund notification is missing its binding fields.'),{status:400});
  return{accepted:true,eventId:envelope.id,refundId:payload.out_refund_no,providerRefundId:payload.refund_id||null,status:mapRefundStatus(payload.refund_status),orderNumber:payload.out_trade_no,amountCents:payload.amount.refund,totalCents:payload.amount.total,currency:payload.amount.currency.toLowerCase()};
}

/**
 * WeChat Pay trade_state -> our payment ledger state (only the transitions we drive).
 * SUCCESS uses the separately verified notification or signed-query path, not this mapper.
 */
function mapTradeState(tradeState){
  switch(String(tradeState||'').toUpperCase()){
    case 'NOTPAY': return 'processing';
    case 'PAYERROR': return 'failed';
    case 'CLOSED': case 'REVOKED': return 'failed';
    case 'REFUND': return null;
    default: return null;
  }
}

/** Validate a trade query response bound to an order. Only this server-side provider
 * response or a verified notification may be used to apply payment success. */
function verifiedPaymentFromQuery(order,payload){
  const c=ready(order);
  if(!payload||payload.trade_state!=='SUCCESS')return{ok:false,status:409,message:'Provider has not confirmed payment success.'};
  if(payload.out_trade_no!==order.number||payload.mchid!==c.mchId||payload.appid!==c.appId||!payload.transaction_id||payload.amount?.total!==order.totalCents||String(payload.amount?.currency||'').toLowerCase()!==order.currency)return{ok:false,status:409,message:'Provider payment query does not match the order.'};
  return{ok:true,notification:{transactionId:payload.transaction_id,amountCents:payload.amount.total,currency:order.currency}};
}

function activeProviderName(){return enabled()?'wechatpay':'disabled';}
module.exports={enabled,readiness,activeProviderName,createPayment,closePayment,queryPayment,handlePaymentNotification,requestRefund,queryRefund,handleRefundNotification,mapRefundStatus,mapTradeState,verifiedPaymentFromQuery,verifyEnvelope,decrypt,formatWeChatTime};
