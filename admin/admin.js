'use strict';
let csrf=sessionStorage.getItem('loam_csrf')||'',page=1,pages=1,currentRole='viewer';
const $=id=>document.getElementById(id);
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money=(cents,currency)=>new Intl.NumberFormat('en-US',{style:'currency',currency:String(currency||'usd').toUpperCase()}).format(cents/100);
async function api(path,options={}){
  const response=await fetch(path,{...options,headers:{...(options.body?{'Content-Type':'application/json'}:{}),...(options.method&&options.method!=='GET'?{'X-CSRF-Token':csrf}:{}),...(options.headers||{})}});
  const data=await response.json().catch(()=>({}));
  if(response.status===401){sessionStorage.removeItem('loam_csrf');location.replace('/admin/login');throw new Error('Session expired.');}
  if(!response.ok)throw new Error(data.message||'Request failed.');
  return data;
}
async function init(){
  try{const s=await api('/api/admin/session');csrf=s.csrfToken;currentRole=s.role||'viewer';sessionStorage.setItem('loam_csrf',csrf);$('user').textContent=s.username;await Promise.all([loadStats(),loadOrders(),loadUnallocated()]);const health=await api('/api/health');if($('paymentNotice'))$('paymentNotice').textContent=health.paymentEnabled?'Payment provider configuration passed readiness; only verified provider results may change payment status.':'New payments/refunds are disabled. Existing ledger entries remain authoritative; fulfilment updates never change payment status.';}
  catch(e){$('message').textContent=e.message;}
}
async function loadStats(){
  const {stats}=await api('/api/admin/stats');
  for(const [id,key]of[['total','orders'],['unpaid','unpaid'],['paid','paid'],['action','toProcess'],['unallocated','unallocated'],['callbackFailures','webhookFailuresLastHour']])if($(id))$(id).textContent=stats[key]??0;
  if($('unallocatedCard'))$('unallocatedCard').hidden=!stats.unallocated;
}
async function loadOrders(){
  $('message').textContent='Loading orders…';
  try{
    const params=new URLSearchParams({q:$('q').value,paymentStatus:$('payment').value,fulfillmentStatus:$('fulfillment').value,sort:$('sort').value,page:String(page),pageSize:'20'});
    const data=await api('/api/admin/orders?'+params);pages=data.pages;
    $('rows').innerHTML=data.orders.length?data.orders.map(o=>`<tr><td><strong>${esc(o.number)}</strong><br><span class="muted">${esc(new Date(o.createdAt).toLocaleString())}</span></td><td>${esc(o.customer.firstName)} ${esc(o.customer.lastName)}<br><span class="muted">${esc(o.customer.email)}</span></td><td>${money(o.totalCents,o.currency)}</td><td><span class="badge ${esc(o.paymentStatus)}">${esc(o.paymentStatus)}</span></td><td><span class="badge ${esc(o.fulfillmentStatus)}">${esc(o.fulfillmentStatus)}</span></td><td><button class="btn secondary" data-order="${esc(o.number)}" type="button">View</button></td></tr>`).join(''):'<tr><td colspan="6">No orders match these filters.</td></tr>';
    $('page').textContent=`Page ${data.page} of ${data.pages} · ${data.total} orders`;$('prev').disabled=data.page<=1;$('next').disabled=data.page>=data.pages;$('message').textContent='';
  }catch(e){$('message').textContent=e.message;}
}
async function loadUnallocated(){
  if(!$('unallocatedRows'))return;
  try{
    const data=await api('/api/admin/unallocated');
    $('unallocatedRows').innerHTML=data.orders.length?data.orders.map(o=>`<tr><td><strong>${esc(o.number)}</strong></td><td>${esc(o.customer.firstName)} ${esc(o.customer.lastName)}<br><span class="muted">${esc(o.customer.email)}</span></td><td>${money(o.totalCents,o.currency)}</td><td>${esc(o.providerTransactionId||'—')}</td><td><button class="btn secondary" data-order="${esc(o.number)}" type="button">Resolve</button></td></tr>`).join(''):'<tr><td colspan="5">No unallocated payments.</td></tr>';
  }catch(e){$('unallocatedRows').innerHTML=`<tr><td colspan="5">${esc(e.message)}</td></tr>`;}
}
function actionButton(label,action,disabled=false){return `<button class="btn secondary" type="button" data-action="${esc(action)}" ${disabled?'disabled':''}>${esc(label)}</button>`;}
async function view(number){
  const data=await api('/api/admin/orders/'+encodeURIComponent(number)),o=data.order;
  const canPay=currentRole!=='viewer'&&['unpaid','failed','processing'].includes(o.paymentStatus)&&!o.stockReleased;
  const payAction=o.paymentStatus==='processing'?'query-payment':'create-payment';
  const refundAllowed=currentRole==='owner'&&['paid','partially_refunded','paid_unallocated','refund_pending'].includes(o.paymentStatus);
  const payments=JSON.stringify(data.payments,null,2),audit=JSON.stringify(data.audit,null,2),events=JSON.stringify(o.events,null,2);
  const refunds=data.refunds||[];
  const refundRequestId='RF-'+crypto.randomUUID().replaceAll('-','');
  $('detailTitle').textContent=o.number;
  $('detailBody').innerHTML=`
    <div class="detail-grid"><section><h3>Customer & delivery</h3><p>${esc(o.customer.firstName)} ${esc(o.customer.lastName)}<br>${esc(o.customer.email)}<br>${esc(o.customer.phone)}<br>${esc(o.customer.address)} ${esc(o.customer.apt)}<br>${esc(o.customer.city)}, ${esc(o.customer.region)} ${esc(o.customer.postal)}<br>${esc(o.customer.country)}</p>
    <h3>Payment</h3><p><span class="badge ${esc(o.paymentStatus)}">${esc(o.paymentStatus)}</span><br>Provider: ${esc(o.provider)}<br>Transaction: ${esc(o.providerTransactionId||'—')}<br>${esc(o.paymentMessage||'')}</p>
    <div class="actions">${canPay?actionButton(o.paymentStatus==='processing'?'Query payment':'Create payment',payAction,!o.paymentEnabled):''}${refundAllowed?actionButton('Request refund','refund',!o.paymentEnabled):''}</div>
    ${o.paymentStatus==='paid_unallocated'?`<p class="error">Payment received, but this order cannot currently be fulfilled. Resolve it before any shipment.</p><div class="actions">${actionButton('Adopt order','adopt',o.stockReleased||currentRole!=='owner')}${actionButton('Refund in full','reconcile-refund',!o.paymentEnabled||currentRole!=='owner')}</div>`:''}
    <div id="paymentResult" role="status"></div>
    ${refundAllowed?`<h3>Refund</h3><p>Refundable: <strong>${money(data.refundableCents,o.currency)}</strong></p><form id="refundForm"><label for="refundAmount">Amount (cents)</label><input id="refundAmount" name="amountCents" type="number" min="1" max="${Math.max(0,data.refundableCents)}" value="${Math.max(0,data.refundableCents)}" required><label for="refundReason">Reason</label><input id="refundReason" name="reason" maxlength="200"><label for="refundPassword">Confirm owner password (required before refund)</label><input id="refundPassword" type="password" autocomplete="current-password" maxlength="256"><button class="btn" type="submit" ${data.refundableCents<=0||!o.paymentEnabled?'disabled':''}>Submit refund</button></form>`:''}
    </section><section><h3>Items & totals</h3><table class="items">${o.items.map(i=>`<tr><td>${esc(i.name)} × ${i.qty}</td><td>${money(i.lineTotalCents,o.currency)}</td></tr>`).join('')}<tr><td>Shipping</td><td>${money(o.shippingCents,o.currency)}</td></tr><tr><td>Tax</td><td>${money(o.taxCents,o.currency)}</td></tr><tr><th>Total</th><th>${money(o.totalCents,o.currency)}</th></tr><tr><td>Refunded</td><td>${money(data.refundedTotalCents||0,o.currency)}</td></tr></table>
    <h3>Fulfilment</h3><form id="statusForm"><label for="newStatus">Status</label><select id="newStatus">${['pending','processing','shipped','completed','cancelled'].map(s=>`<option ${s===o.fulfillmentStatus?'selected':''}>${s}</option>`).join('')}</select><p><button class="btn" type="submit" ${currentRole==='viewer'?'disabled':''}>Save fulfilment status</button></p></form></section></div>
    <h3>Refund history</h3><div class="table-wrap"><table><thead><tr><th>Refund ID</th><th>Amount</th><th>Status</th><th>Updated</th></tr></thead><tbody>${refunds.length?refunds.map(r=>`<tr><td>${esc(r.id)}</td><td>${money(r.amount_cents,o.currency)}</td><td>${esc(r.status)}</td><td>${esc(r.updated_at)} ${r.status==='pending'&&currentRole==='owner'?`<button class="btn secondary" type="button" data-refund="${esc(r.id)}">Query</button>`:''}</td></tr>`).join(''):'<tr><td colspan="4">No refunds.</td></tr>'}</tbody></table></div>
    <h3>Order events</h3><pre>${esc(events)}</pre><h3>Payment events</h3><pre>${esc(payments)}</pre><h3>Admin audit</h3><pre>${esc(audit)}</pre>`;
  $('statusForm').addEventListener('submit',async e=>{e.preventDefault();const button=e.target.querySelector('button');button.disabled=true;try{await api('/api/admin/orders/'+encodeURIComponent(o.number)+'/fulfillment',{method:'PATCH',body:JSON.stringify({status:$('newStatus').value})});$('detail').close();await Promise.all([loadStats(),loadOrders(),loadUnallocated()]);}catch(err){alert(err.message);}finally{button.disabled=false;}});
  $('detailBody').onclick=e=>{const refund=e.target.closest('[data-refund]');if(refund){queryRefund(o,refund.dataset.refund,refund);return;}const b=e.target.closest('[data-action]');if(b)runAction(o,b.dataset.action,b);};
  if($('refundForm'))$('refundForm').addEventListener('submit',async e=>{e.preventDefault();const b=e.target.querySelector('button');b.disabled=true;try{await confirmOwnerPassword();await api(`/api/admin/orders/${encodeURIComponent(o.number)}/refunds`,{method:'POST',body:JSON.stringify({id:refundRequestId,amountCents:Number($('refundAmount').value),reason:$('refundReason').value})});await refreshDetail(o.number);}catch(err){$('paymentResult').textContent=err.message;}finally{b.disabled=false;}});
  $('detail').showModal();
}
async function confirmOwnerPassword(){const field=$('refundPassword');if(!field?.value)throw new Error('Enter your owner password in the refund section first.');const password=field.value;field.value='';await api('/api/admin/reauth',{method:'POST',body:JSON.stringify({password})});}
async function refreshDetail(number){if($('detail').open)$('detail').close();await Promise.all([loadStats(),loadOrders(),loadUnallocated()]);await view(number);}
async function queryRefund(order,id,button){button.disabled=true;try{await api(`/api/admin/orders/${encodeURIComponent(order.number)}/refunds/${encodeURIComponent(id)}`,{method:'POST',body:JSON.stringify({})});await refreshDetail(order.number);}catch(err){const out=$('paymentResult');if(out)out.textContent=err.message;button.disabled=false;}}
async function runAction(order,action,button){
  button.disabled=true;const out=$('paymentResult');if(out)out.textContent='Working…';
  try{
    if(action==='create-payment'||action==='query-payment'){
      const suffix=action==='query-payment'?'/query':'';
      const result=await api(`/api/admin/orders/${encodeURIComponent(order.number)}/payment${suffix}`,{method:'POST',body:JSON.stringify({})});
      if(result.payment?.qrDataUrl)out.innerHTML=`<p>Scan to pay before the order reservation expires.</p><img alt="WeChat Pay QR code" width="240" height="240" src="${esc(result.payment.qrDataUrl)}">`;
      else out.textContent=result.payment?.h5_url?'Payment link: '+result.payment.h5_url:'Payment state: '+(result.order?.paymentStatus||'processing');
      if(result.payment?.qrDataUrl){await Promise.all([loadStats(),loadOrders()]);button.disabled=false;}
      else await refreshDetail(order.number);
    }else if(action==='adopt'){
      await confirmOwnerPassword();await api(`/api/admin/orders/${encodeURIComponent(order.number)}/reconcile`,{method:'POST',body:JSON.stringify({action:'adopt'})});await refreshDetail(order.number);
    }else if(action==='reconcile-refund'){
      await confirmOwnerPassword();await api(`/api/admin/orders/${encodeURIComponent(order.number)}/reconcile`,{method:'POST',body:JSON.stringify({action:'refund'})});await refreshDetail(order.number);
    }else if(action==='refund'){
      $('refundAmount')?.focus();button.disabled=false;
    }
  }catch(err){if(out)out.textContent=err.message;button.disabled=false;}
}
$('filters').addEventListener('submit',e=>{e.preventDefault();page=1;loadOrders();});
$('reset').onclick=()=>{$('filters').reset();page=1;loadOrders();};
$('prev').onclick=()=>{page--;loadOrders();};$('next').onclick=()=>{page++;loadOrders();};
$('rows').onclick=e=>{const b=e.target.closest('[data-order]');if(b)view(b.dataset.order).catch(err=>$('message').textContent=err.message);};
if($('unallocatedRows'))$('unallocatedRows').onclick=e=>{const b=e.target.closest('[data-order]');if(b)view(b.dataset.order).catch(err=>$('message').textContent=err.message);};
$('close').onclick=()=>$('detail').close();
if($('revokeSessions'))$('revokeSessions').onclick=async()=>{if(!confirm('Sign out every session for this administrator?'))return;await api('/api/admin/sessions/revoke',{method:'POST'});sessionStorage.removeItem('loam_csrf');location.replace('/admin/login');};
$('logout').onclick=async()=>{try{await api('/api/admin/logout',{method:'POST'});}finally{sessionStorage.removeItem('loam_csrf');location.replace('/admin/login');}};
init();
