'use strict';
const crypto=require('crypto');
const {db,transaction}=require('./database');
// SQLite keeps abuse limits across process restarts. Keys are hashed, not raw IPs.
function consume(scope,key,limit,windowMs,now=Date.now()){
  const hash=crypto.createHash('sha256').update(scope+'|'+key).digest('hex');
  return transaction(()=>{
    db.prepare('DELETE FROM rate_limits WHERE reset_at<=?').run(now);
    let row=db.prepare('SELECT count,reset_at FROM rate_limits WHERE key=?').get(hash);
    if(row&&row.count>=limit)return{allowed:false,retryAfter:Math.max(1,Math.ceil((row.reset_at-now)/1000))};
    // Bound disk growth under random-key floods too (fail closed, don't evict live limits).
    if(!row&&db.prepare('SELECT COUNT(*) n FROM rate_limits').get().n>=50000)return{allowed:false,retryAfter:60};
    const resetAt=row?row.reset_at:now+windowMs;
    db.prepare('INSERT INTO rate_limits(key,count,reset_at) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1').run(hash,resetAt);
    return{allowed:true,retryAfter:0};
  });
}
function clear(scope,key){db.prepare('DELETE FROM rate_limits WHERE key=?').run(crypto.createHash('sha256').update(scope+'|'+key).digest('hex'));}
module.exports={consume,clear};
