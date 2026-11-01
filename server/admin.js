'use strict';
const crypto=require('crypto');
const argon2=require('argon2');
const store=require('./store');
const orders=require('./orders');
const {db}=require('./database');
const {clientIp}=require('./network');
const limits=require('./rate-limit');
const SESSION_TTL_MS=8*60*60*1000;
function cookies(req){const result={};for(const part of String(req.headers.cookie||'').split(';')){const i=part.indexOf('=');if(i>0)try{result[part.slice(0,i).trim()]=decodeURIComponent(part.slice(i+1).trim());}catch(_){}}return result;}
function session(req){const token=cookies(req).loam_admin;if(!token)return null;const row=db.prepare('SELECT s.*,a.username,a.disabled,a.role FROM sessions s JOIN admins a ON a.id=s.admin_id WHERE s.token_hash=?').get(store.hash(token));if(!row)return null;if(row.disabled||Date.parse(row.expires_at)<=Date.now()||Date.now()-Date.parse(row.last_seen_at||row.created_at)>30*60*1000){db.prepare('DELETE FROM sessions WHERE token_hash=?').run(row.token_hash);return null;}db.prepare('UPDATE sessions SET last_seen_at=? WHERE token_hash=?').run(store.now(),row.token_hash);return{token,hash:row.token_hash,adminId:row.admin_id,username:row.username,role:row.role,reauthenticatedAt:row.reauthenticated_at,csrf:row.csrf_token};}
function requireAdmin(req,res){const s=session(req);if(!s){res.writeHead(401,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify({ok:false,message:'Authentication required.'}));return null;}return s;}
function csrf(req,s){const value=req.headers['x-csrf-token'];return typeof value==='string'&&/^[a-f0-9]{64}$/.test(value)&&crypto.timingSafeEqual(Buffer.from(value),Buffer.from(s.csrf));}
function cookie(token,maxAge){return`loam_admin=${token?encodeURIComponent(token):''}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;}
function attemptKey(req,username){return clientIp(req)+'|'+username.toLowerCase();}
async function login(req,body){
  const username=typeof body.username==='string'?body.username.trim():'',password=typeof body.password==='string'?body.password:'';
  if(!username||username.length>100||password.length>1024)return{status:400,body:{ok:false,message:'Invalid login.'}};
  const key=attemptKey(req,username);
  const source=limits.consume('login-source',clientIp(req),30,15*60*1000);
  const pair=source.allowed?limits.consume('login-pair',key,5,15*60*1000):source;
  if(!pair.allowed)return{status:429,headers:{'Retry-After':String(pair.retryAfter)},body:{ok:false,message:'Too many login attempts. Try later.'}};
  const account=db.prepare('SELECT * FROM admins WHERE username=? COLLATE NOCASE').get(username);
  const valid=account&&!account.disabled&&await argon2.verify(account.password_hash,password).catch(()=>false);
  if(!valid){if(account)orders.audit(account.username,'admin.login_failed',null);return{status:401,body:{ok:false,message:'Invalid username or password.'}};}
  limits.clear('login-pair',key);
  const token=crypto.randomBytes(32).toString('base64url'),csrf=crypto.randomBytes(32).toString('hex'),now=new Date(),expiresAt=new Date(now.getTime()+SESSION_TTL_MS).toISOString();
  db.prepare('DELETE FROM sessions WHERE expires_at<=?').run(now.toISOString());
  db.prepare('INSERT INTO sessions(token_hash,admin_id,csrf_token,created_at,expires_at,last_seen_at) VALUES(?,?,?,?,?,?)').run(store.hash(token),account.id,csrf,now.toISOString(),expiresAt,now.toISOString());
  orders.audit(account.username,'admin.login',null);
  return{status:200,headers:{'Set-Cookie':cookie(token,SESSION_TTL_MS/1000)},body:{ok:true,username:account.username,csrfToken:csrf,expiresAt}};
}
async function reauthenticate(req,s,body){
  const limit=limits.consume('admin-reauth',s.adminId+'|'+clientIp(req),5,15*60*1000);
  if(!limit.allowed)return{status:429,body:{ok:false,message:'Too many reauthentication attempts.'}};
  const account=db.prepare('SELECT password_hash FROM admins WHERE id=? AND disabled=0').get(s.adminId);
  const password=typeof body.password==='string'&&body.password.length<=256?body.password:'';
  if(!account||!await argon2.verify(account.password_hash,password).catch(()=>false))return{status:403,body:{ok:false,message:'Password verification failed.'}};
  db.prepare('UPDATE sessions SET reauthenticated_at=? WHERE token_hash=?').run(store.now(),s.hash);
  orders.audit(s.username,'admin.reauthenticated',null);return{status:200,body:{ok:true}};
}
function recentlyAuthenticated(s){return Date.now()-Date.parse(s.reauthenticatedAt||'')<5*60*1000;}
function revokeAll(s){db.prepare('DELETE FROM sessions WHERE admin_id=?').run(s.adminId);orders.audit(s.username,'admin.sessions_revoked',null);return{status:200,headers:{'Set-Cookie':cookie('',0)},body:{ok:true}};}
function logout(req,s){db.prepare('DELETE FROM sessions WHERE token_hash=?').run(s.hash);orders.audit(s.username,'admin.logout',null);return{status:200,headers:{'Set-Cookie':cookie('',0)},body:{ok:true}};}
module.exports={session,requireAdmin,csrf,cookie,login,logout,revokeAll,reauthenticate,recentlyAuthenticated,SESSION_TTL_MS,attemptKey};
