'use strict';
const {db,transaction}=require('./database');
const store=require('./store');
/** Financial/order/refund/callback success records are deliberately never purged here. */
function retention({apply=false,days=30,now=Date.now()}={}){
  if(!Number.isInteger(days)||days<30)throw new Error('Retention must be at least 30 days.');
  if(apply&&process.env.LOAM_RETENTION_APPROVED!=='true')throw new Error('Review and approve the retention policy before applying (LOAM_RETENTION_APPROVED=true).');
  const cutoff=new Date(now-days*86400000).toISOString();
  const predicate="created_at<? AND order_number IN (SELECT number FROM orders WHERE fulfillment_status='cancelled' AND payment_status='failed')";
  return transaction(()=>{
    const result={dryRun:!apply,cutoff,idempotency:db.prepare('SELECT COUNT(*) n FROM idempotency WHERE '+predicate).get(cutoff).n,webhookFailures:db.prepare('SELECT COUNT(*) n FROM webhook_failures WHERE created_at<?').get(cutoff).n};
    if(apply){
      db.prepare('DELETE FROM idempotency WHERE '+predicate).run(cutoff);
      db.prepare('DELETE FROM webhook_failures WHERE created_at<?').run(cutoff);
      db.prepare('INSERT INTO audit_log(actor,action,detail_json,created_at) VALUES(?,?,?,?)').run('maintenance','retention.applied',JSON.stringify(result),store.now());
    }
    return result;
  });
}
if(require.main===module){try{const args=process.argv.slice(2);if(args.some(a=>a!=='--apply'))throw new Error('Usage: node server/retention.js [--apply] (default: dry-run)');console.log(JSON.stringify(retention({apply:args.includes('--apply')})));}catch(err){console.error(err.message);process.exitCode=1;}finally{store.close();}}
module.exports={retention};
