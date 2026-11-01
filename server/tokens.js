'use strict';
/** Keeps replayed order capabilities recoverable without storing them in plaintext. */
const fs=require('fs');
const path=require('path');
const crypto=require('crypto');
const {DATA_DIR}=require('./database');
let key;
if(process.env.LOAM_TOKEN_KEY)key=Buffer.from(process.env.LOAM_TOKEN_KEY,'base64');
else{const file=path.join(DATA_DIR,'.token-key');try{key=Buffer.from(fs.readFileSync(file,'utf8'),'base64');}catch(_){key=crypto.randomBytes(32);fs.writeFileSync(file,key.toString('base64'),{mode:0o600});}}
if(key.length!==32)throw new Error('LOAM_TOKEN_KEY must be a base64-encoded 32-byte key.');
function seal(value){const iv=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',key,iv),encrypted=Buffer.concat([cipher.update(value,'utf8'),cipher.final()]);return Buffer.concat([iv,cipher.getAuthTag(),encrypted]).toString('base64url');}
function open(value){const raw=Buffer.from(value,'base64url'),decipher=crypto.createDecipheriv('aes-256-gcm',key,raw.subarray(0,12));decipher.setAuthTag(raw.subarray(12,28));return Buffer.concat([decipher.update(raw.subarray(28)),decipher.final()]).toString('utf8');}
module.exports={seal,open};
