'use strict';
/* Product administration. Session, CSRF and role checks are all enforced by the
   server; this file only renders and collects input. Every value is escaped. */
let csrf=sessionStorage.getItem('loam_csrf')||'',role='viewer',editing=null,imagePath='';
const $=id=>document.getElementById(id);
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const yuan=cents=>'¥'+(cents/100).toFixed(2);
async function api(path,options={}){
  const response=await fetch(path,{...options,headers:{...(options.body&&!options.raw?{'Content-Type':'application/json'}:{}),...(options.method&&options.method!=='GET'?{'X-CSRF-Token':csrf}:{}),...(options.headers||{})}});
  const data=await response.json().catch(()=>({}));
  if(response.status===401){sessionStorage.removeItem('loam_csrf');location.replace('/admin/login');throw new Error('Session expired.');}
  if(!response.ok)throw new Error(data.message||'Request failed.');
  return data;
}
const readOnly=()=>role==='viewer';
async function init(){
  try{
    const s=await api('/api/admin/session');csrf=s.csrfToken;role=s.role||'viewer';sessionStorage.setItem('loam_csrf',csrf);$('user').textContent=s.username;
    if(readOnly())$('newProduct').disabled=true;
    await load();
  }catch(e){$('message').textContent=e.message;}
}
async function load(){
  const {products}=await api('/api/admin/products');
  $('rows').innerHTML=products.length?products.map(p=>`<tr><td><strong>${esc(p.name)}</strong><br><span class="muted">${esc(p.id)}${p.size?' · '+esc(p.size):''}</span></td><td>${yuan(p.priceCents)}</td><td>${p.available}<br><span class="muted">of ${p.stock} on hand</span></td><td><span class="badge ${esc(p.status)}">${esc(p.status)}</span></td><td><span class="muted">${esc(p.updatedAt?new Date(p.updatedAt).toLocaleString():'—')}</span></td><td><div class="actions"><button class="btn secondary" data-edit="${esc(p.id)}" type="button">Edit</button><button class="btn secondary" data-toggle="${esc(p.id)}" data-status="${p.status==='active'?'archived':'active'}" type="button" ${readOnly()?'disabled':''}>${p.status==='active'?'Unpublish':'Publish'}</button><button class="btn secondary" data-delete="${esc(p.id)}" type="button" ${readOnly()||!p.deletable?'disabled':''} title="${p.deletable?'':'Referenced by orders; archive instead'}">Delete</button></div></td></tr>`).join(''):'<tr><td colspan="6">No products yet.</td></tr>';
  $('message').textContent='';
  return products;
}
function openEditor(product){
  editing=product||null;
  imagePath=product?product.image||'':'';
  $('editorTitle').textContent=product?'Edit '+product.name:'New product';
  $('fName').value=product?product.name:'';
  $('fId').value=product?product.id:'';
  $('fId').disabled=!!product;
  $('fSize').value=product?product.size:'';
  $('fPrice').value=product?(product.priceCents/100).toFixed(2):'';
  $('fStock').value=product?product.stock:0;
  $('fSort').value=product?product.sort:0;
  $('fStatus').value=product?product.status:'draft';
  $('fDesc').value=product?product.description:'';
  $('fImage').value='';
  $('formError').textContent='';
  const preview=$('fPreview');
  if(imagePath){preview.src=imagePath;preview.hidden=false;}else{preview.removeAttribute('src');preview.hidden=true;}
  $('editor').showModal();
}
async function save(event){
  event.preventDefault();
  const button=$('saveProduct');button.disabled=true;$('formError').textContent='';
  try{
    const price=Math.round(Number($('fPrice').value)*100);
    if(!Number.isSafeInteger(price)||price<0)throw new Error('Enter a price in yuan, e.g. 46.00.');
    const payload={name:$('fName').value.trim(),size:$('fSize').value.trim(),priceCents:price,stock:Number($('fStock').value),sort:Number($('fSort').value),status:$('fStatus').value,description:$('fDesc').value};
    if(!editing&&$('fId').value.trim())payload.id=$('fId').value.trim();
    const saved=editing
      ?await api('/api/admin/products/'+encodeURIComponent(editing.id),{method:'PATCH',body:JSON.stringify(payload)})
      :await api('/api/admin/products',{method:'POST',body:JSON.stringify(payload)});
    if($('fImage').files.length)await uploadImage(saved.product.id);
    $('editor').close();await load();
  }catch(err){$('formError').textContent=err.message;}
  finally{button.disabled=false;}
}
async function uploadImage(id){
  const file=$('fImage').files[0];
  if(file.size>2*1024*1024)throw new Error('Image must be 2 MB or smaller.');
  const type=file.type==='image/jpeg'?'image/jpeg':file.type==='image/png'?'image/png':file.type==='image/webp'?'image/webp':'';
  if(!type)throw new Error('Choose a JPEG, PNG or WebP image.');
  const result=await api('/api/admin/products/'+encodeURIComponent(id)+'/image',{method:'POST',raw:true,headers:{'Content-Type':type},body:file});
  imagePath=result.product.image;
}
$('productForm').addEventListener('submit',save);
$('newProduct').onclick=()=>openEditor(null);
$('cancelEdit').onclick=()=>$('editor').close();
$('clearImage').onclick=async()=>{
  if(!editing)return;
  try{await api('/api/admin/products/'+encodeURIComponent(editing.id)+'/image',{method:'DELETE'});imagePath='';$('fPreview').hidden=true;$('fPreview').removeAttribute('src');await load();}
  catch(err){$('formError').textContent=err.message;}
};
$('rows').onclick=async event=>{
  const editButton=event.target.closest('[data-edit]');
  const toggleButton=event.target.closest('[data-toggle]');
  const deleteButton=event.target.closest('[data-delete]');
  try{
    if(editButton){const products=await api('/api/admin/products');openEditor(products.products.find(p=>p.id===editButton.dataset.edit));return;}
    if(toggleButton){
      toggleButton.disabled=true;
      await api('/api/admin/products/'+encodeURIComponent(toggleButton.dataset.toggle)+'/status',{method:'POST',body:JSON.stringify({status:toggleButton.dataset.status})});
      await load();return;
    }
    if(deleteButton){
      if(!confirm('Delete this product permanently? Products that appear in any order cannot be deleted — archive them instead.'))return;
      await api('/api/admin/products/'+encodeURIComponent(deleteButton.dataset.delete),{method:'DELETE'});
      await load();return;
    }
  }catch(err){$('message').textContent=err.message;if(toggleButton)toggleButton.disabled=false;}
};
$('logout').onclick=async()=>{try{await api('/api/admin/logout',{method:'POST'});}finally{sessionStorage.removeItem('loam_csrf');location.replace('/admin/login');}};
init();
