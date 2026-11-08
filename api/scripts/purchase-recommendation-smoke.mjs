// Isolated HTTP contract test. Jev is a loopback stub; no real requests leave this process.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';

const Database = createRequire(import.meta.url)('better-sqlite3');
const dir = mkdtempSync(join(tmpdir(), 'nexo-recommendation-'));
const readBody = async (req) => { const chunks=[]; for await (const chunk of req) chunks.push(chunk); return JSON.parse(Buffer.concat(chunks).toString() || '{}'); };
let providerMode = 'success', providerCalls = 0;
const provider = createServer(async (req,res) => {
  const body=await readBody(req);providerCalls++;
  if(providerMode==='error'){res.statusCode=503;res.end('unavailable');return;}
  const answers={};
  for(const key of Object.keys(body.questions||{})) answers[key]={type:'noul',noul:0.95};
  res.setHeader('content-type','application/json');res.end(JSON.stringify({model:'jev-test',answers,usage:{input_tokens:1,output_tokens:1}}));
});
await new Promise(resolve=>provider.listen(0,'127.0.0.1',resolve));
const providerUrl=`http://127.0.0.1:${provider.address().port}/v1/systemone`;
const portProbe=createServer();await new Promise(resolve=>portProbe.listen(0,'127.0.0.1',resolve));const port=portProbe.address().port;await new Promise(resolve=>portProbe.close(resolve));
const base=`http://127.0.0.1:${port}`,dbPath=join(dir,'recommendation.sqlite');
let child,db,logs='';const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function api(path,method='GET',body){const response=await fetch(base+path,{method,headers:{'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:response.status,body:await response.json()};}
async function start(){
  child=spawn(process.execPath,['dist/main.js'],{stdio:['ignore','pipe','pipe'],env:{...process.env,PORT:String(port),DATABASE_PATH:dbPath,TYPESAFE_API_KEY:'stub-key',TYPESAFE_API_URL:providerUrl,TYPESAFE_MODEL:'jev-test',SUPPLIER_PREFERENCE_FACTOR:'0.8',AGENT_URL:'http://127.0.0.1:1'}});
  child.stdout.on('data',data=>logs+=data);child.stderr.on('data',data=>logs+=data);
  for(let i=0;i<100;i++){if(child.exitCode!==null)throw new Error(logs);try{if((await fetch(base+'/health')).ok)return;}catch{}await wait(50);}throw new Error('API unavailable');
}
async function stop(){if(!child)return;const done=new Promise(resolve=>child.once('exit',resolve));child.kill();await done;child=null;}
function seedRequest(id=randomUUID()){
  const now=new Date().toISOString();
  db.prepare("INSERT INTO requests(id,product,specs,qty,destination,status,decision,version,created_at,quote_completion_state) VALUES(?,?,?,?,?,'concluida',NULL,3,?,'concluida')").run(id,'SSD NVMe 1 TB','{"interface":"PCIe 4.0"}',2,'01001-000',now);
  const supplierId=`supplier-${id}`,marketId=`market-${id}`;
  db.prepare(`INSERT INTO quotes(id,request_id,event_id,supplier,unit_cents,shipping_cents,fees_cents,lead_days,available_qty,conditions,source_url,product_confirmed,destination_confirmed,created_at,supplier_chat_id)
    VALUES(?,?,?,?,6000,0,0,2,10,'SSD NVMe 1 TB quoted at R$60 each','https://supplier.invalid/quote',1,1,?,?)`).run(supplierId,id,`telegram:${id}`,'Fornecedor',now,'seller-chat');
  db.prepare(`INSERT INTO quotes(id,request_id,event_id,supplier,unit_cents,shipping_cents,fees_cents,lead_days,available_qty,conditions,source_url,product_confirmed,destination_confirmed,created_at)
    VALUES(?,?,?,'Loja Online',5000,NULL,NULL,NULL,NULL,'SSD NVMe 1 TB | https://market.invalid/ssd | evidência abcdef0123456789','https://market.invalid/ssd',0,0,?)`).run(marketId,id,`market:${id}`,now);
  db.prepare('UPDATE requests SET completed_quote_id=? WHERE id=?').run(supplierId,id);
  return {id,supplierId,marketId};
}

try {
  await start();db=new Database(dbPath);
  const first=seedRequest();
  let generated=await api(`/requests/${first.id}/purchase-recommendation`,'POST',{version:3});
  assert.equal(generated.status,201);assert.equal(generated.body.recommendation,'supplier');assert.equal(generated.body.comparison_basis,'product_subtotal');
  assert.equal(generated.body.comparison_supplier_cents,12000);assert.equal(generated.body.comparator_market_cents,10000);assert.equal(generated.body.adjusted_supplier_tco_cents,9600);
  const selected=await api(`/requests/${first.id}/purchase-recommendation/approval`,'POST',{review_id:generated.body.review_id,version:3,approved:true});
  assert.equal(selected.status,201);assert.equal(selected.body.selected_offer_id,first.supplierId);assert.equal(selected.body.request.status,'concluida');
  assert.equal(selected.body.request.latest_purchase_recommendation.approval.approved,true);
  assert.equal(db.prepare('SELECT count(*) n FROM purchase_simulations WHERE request_id=?').get(first.id).n,0);
  assert.equal(db.prepare('SELECT count(*) n FROM purchase_outbox WHERE request_id=?').get(first.id).n,0);
  assert.equal((await api(`/requests/${first.id}/purchase-recommendation/approval`,'POST',{review_id:generated.body.review_id,version:3,approved:true})).status,201,'same approval is idempotent');

  generated=await api(`/requests/${first.id}/purchase-recommendation`,'POST',{version:3});
  const declined=await api(`/requests/${first.id}/purchase-recommendation/approval`,'POST',{review_id:generated.body.review_id,version:3,approved:false});
  assert.equal(declined.status,201);assert.equal(declined.body.selected_offer_id,null);assert.equal(declined.body.latest_purchase_recommendation.approval.approved,false);

  const hashCase=seedRequest();generated=await api(`/requests/${hashCase.id}/purchase-recommendation`,'POST',{version:3});
  db.prepare('UPDATE quotes SET unit_cents=5100 WHERE id=?').run(hashCase.marketId);
  assert.equal((await api(`/requests/${hashCase.id}/purchase-recommendation/approval`,'POST',{review_id:generated.body.review_id,version:3,approved:true})).status,409,'changed offer hash rejects approval even without a version bump');

  const supersededCase=seedRequest();const oldReview=await api(`/requests/${supersededCase.id}/purchase-recommendation`,'POST',{version:3});
  await api(`/requests/${supersededCase.id}/purchase-recommendation`,'POST',{version:3});
  assert.equal((await api(`/requests/${supersededCase.id}/purchase-recommendation/approval`,'POST',{review_id:oldReview.body.review_id,version:3,approved:true})).status,409,'superseded review cannot be approved');

  const versionCase=seedRequest();generated=await api(`/requests/${versionCase.id}/purchase-recommendation`,'POST',{version:3});
  db.prepare('UPDATE requests SET version=version+1 WHERE id=?').run(versionCase.id);
  assert.equal((await api(`/requests/${versionCase.id}/purchase-recommendation/approval`,'POST',{review_id:generated.body.review_id,version:3,approved:true})).status,409,'changed request version rejects approval');

  const failureCase=seedRequest();providerMode='error';const callsBefore=providerCalls;
  assert.equal((await api(`/requests/${failureCase.id}/purchase-recommendation`,'POST',{version:3})).status,503);
  assert.equal(providerCalls,callsBefore+1);assert.equal(db.prepare('SELECT count(*) n FROM purchase_recommendation_reviews WHERE request_id=?').get(failureCase.id).n,0,'provider errors are not stored as an answer');
  for(const {id} of [first,hashCase,supersededCase,versionCase,failureCase]){
    assert.equal(db.prepare('SELECT count(*) n FROM purchase_simulations WHERE request_id=?').get(id).n,0);
    assert.equal(db.prepare('SELECT count(*) n FROM purchase_outbox WHERE request_id=?').get(id).n,0);
  }
  console.log('PASS purchase recommendation HTTP: persisted review and GET projection, yes/no approvals, idempotency, stale version/hash rejection, provider failure, and no purchase side effects.');
} catch(error) {
  console.error(`FAIL purchase recommendation HTTP: ${error.stack||error}\nNest logs:\n${logs}`);process.exitCode=1;
} finally {
  await stop();db?.close();await new Promise(resolve=>provider.close(resolve));rmSync(dir,{recursive:true,force:true});
}
