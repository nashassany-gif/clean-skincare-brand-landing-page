'use strict';
const fs=require('fs');
const path=require('path');
const crypto=require('crypto');
const {DatabaseSync}=require('node:sqlite');
const store=require('./store');

/** Online SQLite backup plus its matching token key. Never copy a live WAL database file. */
async function createBackup(directory){
  directory=path.resolve(directory);
  const relative=path.relative(path.resolve(__dirname,'..'),directory);
  if(!relative||(!relative.startsWith('..'+path.sep)&&!path.isAbsolute(relative)))throw new Error('Backup destination must be outside the application/public project directory.');
  fs.mkdirSync(directory,{recursive:true,mode:0o700});
  const destination=path.join(directory,'loam.sqlite');
  if(fs.existsSync(destination))throw new Error('Refusing to overwrite an existing backup. Choose a new directory.');
  await store.backup(destination);
  const check=new DatabaseSync(destination,{readOnly:true});
  try{if(check.prepare('PRAGMA integrity_check').get().integrity_check!=='ok')throw new Error('Backup integrity check failed.');}finally{check.close();}
  if(process.env.LOAM_TOKEN_KEY)fs.writeFileSync(path.join(directory,'.token-key'),process.env.LOAM_TOKEN_KEY,{mode:0o600});
  else fs.copyFileSync(path.join(store.DATA_DIR,'.token-key'),path.join(directory,'.token-key'));
  fs.chmodSync(destination,0o600);fs.chmodSync(path.join(directory,'.token-key'),0o600);
  const hashes={};
  for(const name of ['loam.sqlite','.token-key'])hashes[name]=crypto.createHash('sha256').update(fs.readFileSync(path.join(directory,name))).digest('hex');
  fs.writeFileSync(path.join(directory,'manifest.json'),JSON.stringify({createdAt:new Date().toISOString(),files:hashes},null,2),{mode:0o600});
  return{directory,integrity:'ok'};
}
if(require.main===module){
  const directory=process.argv[2];
  if(!directory){console.error('Usage: node server/backup.js <new-backup-directory>');store.close();process.exitCode=1;}
  else createBackup(path.resolve(directory)).then(result=>console.log(JSON.stringify(result))).catch(err=>{console.error(err.message);process.exitCode=1;}).finally(()=>store.close());
}
module.exports={createBackup};
