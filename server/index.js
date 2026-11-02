'use strict';
const http=require('http');
const fs=require('fs');
const path=require('path');
const catalog=require('./catalog');
const store=require('./store');
const orders=require('./orders');
const payments=require('./payments');
const webhook=require('./webhook');
const admin=require('./admin');
const images=require('./images');
const {db}=require('./database');
const {clientIp}=require('./network');
const limits=require('./rate-limit');
const ROOT=path.join(__dirname,'..');
const PORT=Number(process.env.PORT||8787),HOST=process.env.HOST||'127.0.0.1';
const MIME={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.webp':'image/webp','.png':'image/png','.jpg':'image/jpeg','.svg':'image/svg+xml','.woff2':'font/woff2'};
function allowOrderCreation(req){return limits.consume('order-create',clientIp(req),4,30*60*1000);}
function sendJson(res,status,obj,headers={}){const body=JSON.stringify(obj);res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Content-Length':Buffer.byteLength(body),'Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...headers});res.end(body);}
function readBody(req,limit=100*1024){return new Promise((resolve,reject)=>{const chunks=[];let size=0;req.on('data',c=>{size+=c.length;if(size>limit){reject(Object.assign(new Error('Payload too large.'),{status:413}));req.destroy();}else chunks.push(c);});req.on('end',()=>resolve(Buffer.concat(chunks)));req.on('error',reject);});}
/**
 * Read a body up to `limit`, but keep draining past it so the client still gets a
 * 413 response instead of a reset connection. Memory stays bounded.
 */
function readBodyDrain(req,limit){return new Promise((resolve,reject)=>{const chunks=[];let size=0,overflow=false;req.on('data',c=>{size+=c.length;if(size>limit)overflow=true;else chunks.push(c);});req.on('end',()=>resolve({buffer:Buffer.concat(chunks),overflow}));req.on('error',reject);});}
async function readJson(req){const raw=await readBody(req);if(!raw.length)return{};try{return JSON.parse(raw.toString('utf8'));}catch(_){throw Object.assign(new Error('Body must be valid JSON.'),{status:400});}}
function serveFile(res,target,download=false){fs.stat(target,(err,stat)=>{if(err||!stat.isFile())return sendJson(res,404,{ok:false,message:'Not found.'});const ext=path.extname(target);res.writeHead(200,{'Content-Type':MIME[ext]||'application/octet-stream','Content-Length':stat.size,'Cache-Control':['.html','.js','.css'].includes(ext)?'no-cache':'public, max-age=86400','X-Content-Type-Options':'nosniff'});fs.createReadStream(target).pipe(res);});}
function serveStatic(req,res,pathname){let decoded;try{decoded=decodeURIComponent(pathname);}catch(_){return sendJson(res,400,{ok:false,message:'Malformed path.'});}if(decoded.includes('\0'))return sendJson(res,400,{ok:false,message:'Malformed path.'});const target=path.resolve(ROOT,'.'+(decoded==='/'?'/index.html':decoded)),rel=path.relative(ROOT,target);if(rel.startsWith('..')||path.isAbsolute(rel))return sendJson(res,403,{ok:false,message:'Forbidden.'});const first=rel.split(path.sep)[0];if(rel!=='index.html'&&!['assets','policies'].includes(first))return sendJson(res,404,{ok:false,message:'Not found.'});serveFile(res,target);}
function adminOrder(o){return{...orders.publicOrder(o),subtotalCents:o.subtotalCents,shippingCents:o.shippingCents,taxCents:o.taxCents,totalCents:o.totalCents,refundedCents:o.refundedCents,provider:o.provider,paymentIntentId:o.paymentIntentId,providerTransactionId:o.providerTransactionId,events:o.events};}
function savedPaymentIntent(number){const row=db.prepare('SELECT response_json,expires_at FROM payment_intents WHERE order_number=?').get(number);if(!row)return null;try{return{...JSON.parse(row.response_json),expires_at:row.expires_at};}catch(_){return null;}}
async function startPayment(order,actor){
  // Enforce reservation expiry before revealing/reusing a payment QR or creating a new one.
  orders.expireReservations();
  order=store.getOrder(order.number);
  const ready=payments.readiness(order);if(!ready.ok)return{status:ready.status,body:{ok:false,code:ready.code,message:ready.message,order:adminOrder(order)}};
  if(order.fulfillmentStatus==='cancelled'||order.stockReleased||!orders.PAYABLE.includes(order.paymentStatus))return{status:409,body:{ok:false,message:'This order cannot accept another payment.'}};
  const existing=savedPaymentIntent(order.number);
  if(order.paymentStatus==='processing'&&existing)return{status:200,body:{ok:true,replayed:true,payment:existing,order:adminOrder(order)}};
  if(order.paymentStatus==='processing'&&!existing)return{status:409,body:{ok:false,message:'Payment initialization is in progress or needs a provider status query before retry.'}};
  const begun=orders.beginPayment(order.number,actor);if(!begun.ok)return{status:begun.status||409,body:{ok:false,message:begun.message}};
  try{
    const fresh=store.getOrder(order.number),providerResponse=await payments.createPayment(fresh);
    const paymentUrl=providerResponse.code_url||providerResponse.h5_url||null;
    const payment={...providerResponse};
    if(providerResponse.code_url){const {default:encodeQR}=await import('qr');payment.qrDataUrl=encodeQR(providerResponse.code_url,'data-url',{scale:6,ecc:'medium'});}
    const expiresAt=fresh.expiresAt;
    store.transaction(()=>db.prepare('INSERT INTO payment_intents(order_number,provider,payment_url,response_json,created_at,expires_at) VALUES(?,?,?,?,?,?) ON CONFLICT(order_number) DO UPDATE SET provider=excluded.provider,payment_url=excluded.payment_url,response_json=excluded.response_json,created_at=excluded.created_at,expires_at=excluded.expires_at').run(order.number,'wechatpay',paymentUrl,JSON.stringify(payment),store.now(),expiresAt));
    return{status:200,body:{ok:true,payment,order:adminOrder(store.getOrder(order.number))}};
  }catch(err){store.event(order.number,'payment.result_unknown',{code:err.code||err.name});return{status:err.status||503,body:{ok:false,code:'payment_result_unknown',message:'Payment creation result is unknown. Query the provider before retrying.',order:adminOrder(store.getOrder(order.number))}};}
}
async function queryAndApplyPayment(order,actor){
  const response=await payments.queryPayment(order);
  if(response.trade_state==='SUCCESS'){
    const verified=payments.verifiedPaymentFromQuery(order,response);
    if(!verified.ok)throw Object.assign(new Error(verified.message),{status:verified.status});
    const applied=orders.applyVerifiedPayment(order.number,verified.notification);
    if(!applied.ok)throw Object.assign(new Error(applied.message||'Payment state rejected.'),{status:applied.status||409});
  }else{
    if(response.out_trade_no!==order.number||response.mchid!==process.env.WECHAT_PAY_MCH_ID||response.appid!==process.env.WECHAT_PAY_APP_ID)throw Object.assign(new Error('Provider payment query does not match the order.'),{status:409});
    const mapped=payments.mapTradeState(response.trade_state);
    if(mapped)orders.applyTradeState(order.number,mapped,response,actor);
  }
  return{payment:response,order:orders.publicOrder(store.getOrder(order.number))};
}
async function startRefund(order,body,actor){
  const ready=payments.readiness(order);if(!ready.ok)return{status:ready.status,body:{ok:false,code:ready.code,message:ready.message}};
  const id=typeof body.id==='string'&&body.id?body.id:'RF-'+order.number+'-'+Date.now();
  if(body.reason!==undefined&&(typeof body.reason!=='string'||body.reason.length>200))return{status:400,body:{ok:false,message:'Refund reason must be text (maximum 200 characters).'}};
  const amountCents=body.amountCents===undefined?Math.max(0,order.totalCents-orders.refundedTotal(order.number)):body.amountCents;
  const created=orders.createRefund(order.number,{id,amountCents,reason:body.reason,actor});
  if(!created.ok)return{status:created.status||409,body:{ok:false,message:created.message}};
  if(created.replayed)return{status:200,body:{ok:true,replayed:true,refund:created.refund,order:adminOrder(store.getOrder(order.number))}};
  try{
    const fresh=store.getOrder(order.number),provider=await payments.requestRefund(fresh,{id,amountCents,reason:body.reason});
    const applied=orders.applyRefundResult(order.number,{id,status:payments.mapRefundStatus(provider.status||provider.refund_status),providerRefundId:provider.refund_id,raw:provider});
    if(!applied.ok)throw Object.assign(new Error(applied.message),{status:applied.status});
    return{status:200,body:{ok:true,refund:applied.refund,provider,order:adminOrder(store.getOrder(order.number))}};
  }catch(err){
    store.event(order.number,'refund.result_unknown',{refundId:id,code:err.code||err.name});
    return{status:err.status||503,body:{ok:false,code:'refund_result_unknown',message:'Refund result is unknown. Its balance remains reserved; query this refund before any retry.',refundId:id,order:adminOrder(store.getOrder(order.number))}};
  }
}
async function handleAdmin(req,res,pathname){const method=req.method;
  if(pathname==='/api/admin/login'&&method==='POST'){const result=await admin.login(req,await readJson(req));return sendJson(res,result.status,result.body,result.headers);}
  const session=admin.requireAdmin(req,res);if(!session)return;
  if(method!=='GET'&&!admin.csrf(req,session))return sendJson(res,403,{ok:false,message:'CSRF validation failed.'});
  if(pathname==='/api/admin/session'&&method==='GET')return sendJson(res,200,{ok:true,username:session.username,role:session.role,csrfToken:session.csrf});
  if(pathname==='/api/admin/logout'&&method==='POST'){const r=admin.logout(req,session);return sendJson(res,r.status,r.body,r.headers);}
  if(pathname==='/api/admin/sessions/revoke'&&method==='POST'){const r=admin.revokeAll(session);return sendJson(res,r.status,r.body,r.headers);}
  if(pathname==='/api/admin/reauth'&&method==='POST'){const r=await admin.reauthenticate(req,session,await readJson(req));return sendJson(res,r.status,r.body);}
  if(session.role==='viewer'&&method!=='GET')return sendJson(res,403,{ok:false,message:'Read-only administrator.'});
  if(pathname==='/api/admin/stats'&&method==='GET')return sendJson(res,200,{ok:true,stats:{...store.stats(),unallocated:orders.unallocatedOrders().length,pendingRefunds:orders.pendingRefunds().length,webhookFailuresLastHour:db.prepare('SELECT COUNT(*) n FROM webhook_failures WHERE created_at>=?').get(new Date(Date.now()-3600000).toISOString()).n}});
  if(pathname==='/api/admin/orders'&&method==='GET'){const q=new URL(req.url,'http://localhost').searchParams;const result=store.listOrders({q:(q.get('q')||'').slice(0,100),paymentStatus:q.get('paymentStatus')||'',fulfillmentStatus:q.get('fulfillmentStatus')||'',from:q.get('from')||'',to:q.get('to')||'',page:q.get('page'),pageSize:q.get('pageSize'),sort:q.get('sort')});result.orders=result.orders.map(adminOrder);return sendJson(res,200,{ok:true,...result});}
  if(pathname==='/api/admin/unallocated'&&method==='GET')return sendJson(res,200,{ok:true,orders:orders.unallocatedOrders().map(adminOrder)});
  const productMatch=pathname.match(/^\/api\/admin\/products(?:\/([a-z0-9-]+)(?:\/(status|image))?)?$/);
  if(productMatch){
    const id=productMatch[1],sub=productMatch[2];
    if(!id&&method==='GET')return sendJson(res,200,{ok:true,products:catalog.listAll(),currency:catalog.CURRENCY});
    if(!id&&method==='POST'){const r=catalog.createProduct(await readJson(req),session.username);return sendJson(res,r.status||(r.ok?201:400),r.ok?{ok:true,product:r.product}:{ok:false,message:r.message});}
    if(id&&!sub&&method==='PATCH'){const r=catalog.updateProduct(id,await readJson(req),session.username);return sendJson(res,r.status||200,r.ok?{ok:true,product:r.product}:{ok:false,message:r.message});}
    if(id&&sub==='status'&&method==='POST'){const body=await readJson(req);const r=catalog.setStatus(id,body.status,session.username);return sendJson(res,r.status||200,r.ok?{ok:true,product:r.product}:{ok:false,message:r.message});}
    if(id&&sub==='image'&&method==='POST'){
      const type=String(req.headers['content-type']||'').split(';')[0].trim().toLowerCase();
      if(!['image/jpeg','image/png','image/webp'].includes(type))return sendJson(res,400,{ok:false,message:'Content-Type must be image/jpeg, image/png or image/webp.'});
      const body=await readBodyDrain(req,images.MAX_BYTES);
      if(body.overflow)return sendJson(res,413,{ok:false,message:'Image must be 2 MB or smaller.'});
      let publicPath;try{publicPath=images.save(body.buffer);}catch(err){return sendJson(res,err.status||400,{ok:false,message:err.message});}
      const before=catalog.getProduct(id);
      const r=catalog.updateProduct(id,{image:publicPath},session.username);
      if(!r.ok){images.remove(publicPath);return sendJson(res,r.status||400,{ok:false,message:r.message});}
      if(before&&before.image&&before.image.startsWith('/uploads/'))images.remove(before.image);
      return sendJson(res,200,{ok:true,product:r.product});
    }
    if(id&&sub==='image'&&method==='DELETE'){const p=catalog.getProduct(id);if(!p)return sendJson(res,404,{ok:false,message:'Product not found.'});const r=catalog.updateProduct(id,{image:''},session.username);if(r.ok&&p.image)images.remove(p.image);return sendJson(res,200,{ok:true,product:r.product});}
    if(id&&!sub&&method==='DELETE'){const r=catalog.deleteProduct(id,session.username);if(r.ok&&r.image&&r.image.startsWith('/uploads/'))images.remove(r.image);return sendJson(res,r.status||200,r.ok?{ok:true}:{ok:false,message:r.message});}
    return sendJson(res,404,{ok:false,message:'Unknown endpoint.'});
  }
  const match=pathname.match(/^\/api\/admin\/orders\/([A-Za-z0-9-]+)(?:\/(fulfillment|cancel|payment(?:\/query)?|reconcile|refunds(?:\/[^/]+)?))?$/);
  if(match){const o=store.getOrder(match[1]);if(!o)return sendJson(res,404,{ok:false,message:'Order not found.'});const action=match[2];
    if(action&&(action==='reconcile'||action.startsWith('refunds'))&&session.role!=='owner')return sendJson(res,403,{ok:false,message:'Owner role required for refunds and reconciliation.'});
    if((action==='refunds'||action==='reconcile')&&!admin.recentlyAuthenticated(session))return sendJson(res,403,{ok:false,code:'reauth_required',message:'Re-enter your password before refund or reconciliation (valid for five minutes).'});
    if(!action&&method==='GET'){const audit=db.prepare('SELECT actor,action,order_number AS orderNumber,detail_json AS detail,created_at AS at FROM audit_log WHERE order_number=? ORDER BY id DESC LIMIT 100').all(o.number);const paymentsLog=db.prepare('SELECT id,event_type AS type,verified,result,created_at AS at FROM payment_events WHERE order_number=? ORDER BY created_at DESC').all(o.number);return sendJson(res,200,{ok:true,order:adminOrder(o),audit,payments:paymentsLog,refunds:orders.listRefunds(o.number),refundedTotalCents:orders.refundedTotal(o.number),refundableCents:Math.max(0,o.totalCents-orders.listRefunds(o.number).filter(r=>['pending','success'].includes(r.status)).reduce((sum,r)=>sum+r.amount_cents,0))});}
    if(action==='fulfillment'&&method==='PATCH'){const body=await readJson(req);const r=orders.updateFulfillment(o.number,body.status,session.username);return sendJson(res,r.status||200,r.ok?{ok:true,order:adminOrder(r.order)}:{ok:false,message:r.message});}
    if(action==='cancel'&&method==='POST'){const r=orders.cancel(o.number,'admin_cancelled');if(r.ok)orders.audit(session.username,'order.cancel',o.number);return sendJson(res,r.status||200,r.ok?{ok:true,order:adminOrder(r.order)}:{ok:false,message:r.message});}
    if(action==='payment'&&method==='POST'){const result=await startPayment(o,session.username);return sendJson(res,result.status,result.body);}
    if(action==='payment/query'&&method==='POST'){try{return sendJson(res,200,{ok:true,...await queryAndApplyPayment(o,session.username)});}catch(err){return sendJson(res,err.status||503,{ok:false,message:err.message});}}
    if(action==='reconcile'&&method==='POST'){
      const body=await readJson(req);
      if(body.action==='refund'){
        const decision=orders.reconcileUnallocated(o.number,'refund',session.username);if(!decision.ok)return sendJson(res,decision.status||409,{ok:false,message:decision.message});
        const result=await startRefund(o,{amountCents:decision.amountCents,reason:'Unallocated payment reconciliation'},session.username);
        return sendJson(res,result.status,result.body);
      }
      const r=orders.reconcileUnallocated(o.number,body.action,session.username);if(!r.ok)return sendJson(res,r.status||409,{ok:false,message:r.message});return sendJson(res,200,{ok:true,order:adminOrder(r.order)});
    }
    if(action==='refunds'&&method==='POST'){const body=await readJson(req);const result=await startRefund(o,body,session.username);return sendJson(res,result.status,result.body);}
    if(action&&action.startsWith('refunds/')&&method==='POST'){const refundId=decodeURIComponent(action.slice(8));try{const r=await payments.queryRefund(o,refundId);const applied=orders.applyRefundResult(o.number,{id:refundId,status:payments.mapRefundStatus(r.status||r.refund_status),providerRefundId:r.refund_id,raw:r});if(!applied.ok)return sendJson(res,applied.status||409,{ok:false,message:applied.message});return sendJson(res,200,{ok:true,refund:applied.refund,provider:r,order:adminOrder(store.getOrder(o.number))});}catch(err){return sendJson(res,err.status||503,{ok:false,message:err.message});}}
  }
  return sendJson(res,404,{ok:false,message:'Unknown endpoint.'});
}
async function handleApi(req,res,pathname){const method=req.method;
  if(pathname.startsWith('/api/admin/'))return handleAdmin(req,res,pathname);
  if(pathname==='/api/health'&&method==='GET')return sendJson(res,200,{ok:true,database:'sqlite',paymentProvider:'wechatpay',paymentEnabled:payments.readiness({currency:catalog.CURRENCY}).ok,currency:catalog.CURRENCY,time:new Date().toISOString()});
  if(pathname==='/api/products'&&method==='GET')return sendJson(res,200,{ok:true,currency:catalog.CURRENCY,shipping:{standard:catalog.SHIPPING.standard.cents/100,express:catalog.SHIPPING.express.cents/100,freeOver:catalog.SHIPPING.standard.freeOverCents/100},taxRate:catalog.TAX_RATE,products:catalog.listPublic().map(p=>({id:p.id,name:p.name,size:p.size,price:p.priceCents/100,description:p.description,image:p.image,available:p.available}))});
  if(pathname==='/api/orders'&&method==='POST'){const limit=allowOrderCreation(req);if(!limit.allowed)return sendJson(res,429,{ok:false,message:'Too many order attempts. Please try again later.'},{'Retry-After':String(limit.retryAfter)});const body=await readJson(req);const r=orders.createOrder({items:body.items,shipping:body.shipping,customer:body.customer,idempotencyKey:req.headers['idempotency-key'],requirePriceConfirmation:true,expectedTotalCents:body.expectedTotalCents});if(!r.ok)return sendJson(res,r.status||400,{ok:false,code:r.code,message:r.message});return sendJson(res,r.replayed?200:201,{ok:true,replayed:r.replayed,orderToken:r.orderToken||null,order:orders.publicOrder(r.order)});}
  const orderMatch=pathname.match(/^\/api\/orders\/([A-Za-z0-9-]+)$/);if(orderMatch&&method==='GET'){const o=store.getOrder(orderMatch[1]);if(!orders.canAccessOrder(o,req.headers['x-order-token']))return sendJson(res,404,{ok:false,message:'Order not found.'});return sendJson(res,200,{ok:true,order:orders.publicOrder(o)});}
  const cancelMatch=pathname.match(/^\/api\/orders\/([A-Za-z0-9-]+)\/cancel$/);if(cancelMatch&&method==='POST'){const o=store.getOrder(cancelMatch[1]);if(!orders.canAccessOrder(o,req.headers['x-order-token']))return sendJson(res,404,{ok:false,message:'Order not found.'});const r=orders.cancel(o.number);return sendJson(res,r.status||200,r.ok?{ok:true,order:orders.publicOrder(r.order)}:{ok:false,message:r.message});}
  const customerPaymentMatch=pathname.match(/^\/api\/orders\/([A-Za-z0-9-]+)\/payment(?:\/(query))?$/);
  if(customerPaymentMatch&&method==='POST'){
    const o=store.getOrder(customerPaymentMatch[1]);
    if(!orders.canAccessOrder(o,req.headers['x-order-token']))return sendJson(res,404,{ok:false,message:'Order not found.'});
    if(customerPaymentMatch[2]){try{return sendJson(res,200,{ok:true,...await queryAndApplyPayment(o,null)});}catch(err){return sendJson(res,err.status||503,{ok:false,message:err.message});}}
    const result=await startPayment(o,null);return sendJson(res,result.status,result.body);
  }
  if(pathname==='/api/webhooks/wechatpay'&&method==='POST'){const r=webhook.handlePaymentNotification(await readBody(req),req.headers);return sendJson(res,r.status,r.body);}
  if(pathname==='/api/webhooks/wechatpay/refund'&&method==='POST'){const r=webhook.handleRefundNotification(await readBody(req),req.headers);return sendJson(res,r.status,r.body);}
  if(pathname==='/api/newsletter'&&method==='POST'){if(process.env.LOAM_NEWSLETTER_COLLECTION_ENABLED!=='true')return sendJson(res,503,{ok:false,message:'Newsletter collection is disabled until privacy consent and an email provider are configured. No address was saved.'});const allowed=limits.consume('newsletter',clientIp(req),5,60*60*1000);if(!allowed.allowed)return sendJson(res,429,{ok:false,message:'Too many subscription attempts.'},{'Retry-After':String(allowed.retryAfter)});const body=await readJson(req),email=typeof body.email==='string'?body.email.trim().toLowerCase():'';if(email.length>254||!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email))return sendJson(res,400,{ok:false,message:'That email address looks incomplete.'});const duplicate=store.addNewsletter(email);return sendJson(res,duplicate?200:201,{ok:true,duplicate,message:duplicate?'You are already on the list.':'Subscribed.'});}
  return sendJson(res,404,{ok:false,message:'Unknown endpoint.'});
}
const server=http.createServer(async(req,res)=>{let pathname;try{pathname=new URL(req.url,'http://localhost').pathname;}catch(_){return sendJson(res,400,{ok:false,message:'Bad request.'});}res.setHeader('Referrer-Policy','strict-origin-when-cross-origin');const isLoginPage=pathname==='/admin/login'||pathname==='/admin';res.setHeader('X-Frame-Options',isLoginPage?'DENY':'SAMEORIGIN');res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors "+(isLoginPage?"'none'":"'self'")+"; base-uri 'self'; form-action 'self'");try{if(pathname==='/admin/login'||pathname==='/admin')return serveFile(res,path.join(ROOT,'admin',pathname==='/admin/login'?'login.html':'index.html'));
if(pathname==='/admin/products')return serveFile(res,path.join(ROOT,'admin','products.html'));
if(pathname.startsWith('/admin/')){if(!['/admin/admin.css','/admin/admin.js','/admin/login.js','/admin/products.js'].includes(pathname))return sendJson(res,404,{ok:false,message:'Not found.'});return serveFile(res,path.join(ROOT,pathname));}if(pathname.startsWith('/uploads/')){if(req.method!=='GET'&&req.method!=='HEAD')return sendJson(res,405,{ok:false,message:'Method not allowed.'});let decoded;try{decoded=decodeURIComponent(pathname);}catch(_){return sendJson(res,400,{ok:false,message:'Malformed path.'});}const target=images.resolve(decoded);if(!target)return sendJson(res,404,{ok:false,message:'Not found.'});return serveFile(res,target);}if(pathname.startsWith('/api/'))await handleApi(req,res,pathname);else serveStatic(req,res,pathname);}catch(err){if((err.status||500)>=500)console.error('[request_error]',err.code||err.name);if(!res.headersSent)sendJson(res,err.status||500,{ok:false,message:(err.status||500)>=500?'Server error.':err.message});}});
if(require.main===module){server.listen(PORT,HOST,()=>console.log(`loam shop listening on http://${HOST}:${PORT} (payments ${payments.enabled()?'enabled':'disabled'})`));const sweep=setInterval(()=>{try{orders.expireReservations();}catch(err){console.error('[stock_sweep]',err.code||err.name);}},60*1000);sweep.unref();const reconcile=setInterval(()=>{reconcileProviderPayments().catch(err=>console.error('[payment_reconcile]',err.code||err.name));},2*60*1000);reconcile.unref();const close=()=>server.close(()=>{store.close();process.exit(0);});process.on('SIGTERM',close);process.on('SIGINT',close);}
/**
 * Safety net for missed/blocked payment callbacks. While an order shows a QR,
 * the provider holds the truth: query it and apply only signature-verified
 * results (queryAndApplyPayment never marks paid from an unverified payload).
 * Expired attempts are closed at the provider so a customer cannot pay into a
 * cancelled reservation. Runs only when the provider is enabled.
 */
async function reconcileProviderPayments(){
  if(!payments.enabled())return;
  const rows=db.prepare("SELECT o.number FROM orders o JOIN payment_intents pi ON pi.order_number=o.number WHERE o.provider_transaction_id IS NULL AND o.payment_status IN ('processing','failed') AND pi.created_at>=? ORDER BY pi.created_at DESC LIMIT 50").all(new Date(Date.now()-24*3600*1000).toISOString());
  for(const {number} of rows){
    try{
      orders.expireReservations();
      const order=store.getOrder(number);
      if(!order)continue;
      const result=await queryAndApplyPayment(order,'reconciler');
      const state=result&&result.payment&&result.payment.trade_state;
      if(state==='NOTPAY'||state==='USERPAYING'){
        const fresh=store.getOrder(number);
        if(fresh&&fresh.expiresAt&&Date.parse(fresh.expiresAt)<=Date.now()){
          await payments.closePayment(fresh).catch(()=>{});
          orders.applyTradeState(number,'failed',{trade_state:'CLOSED'},'reconciler');
        }else if(fresh&&fresh.paymentStatus==='failed'){
          await payments.closePayment(fresh).catch(()=>{});
        }
      }
    }catch(err){console.error('[payment_reconcile]',number,err.code||err.name);}
  }
}
module.exports={server};
