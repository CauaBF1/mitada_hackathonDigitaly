import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { seedHistory } from './history-fixtures.mjs';
const Database=createRequire(import.meta.url)('better-sqlite3');
const dir=mkdtempSync(join(tmpdir(),'nexo-history-'));
const dbPath=join(dir,'history.sqlite');
const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;await new Promise(r=>server.close(r));
const base=`http://127.0.0.1:${port}`;
let child,db,logs='';
async function start(){
  child=spawn(process.execPath,['dist/main.js'],{stdio:['ignore','pipe','pipe'],env:{...process.env,PORT:String(port),DATABASE_PATH:dbPath,TELEGRAM_BOT_TOKEN:''}});
  child.stdout.on('data',d=>logs+=d);child.stderr.on('data',d=>logs+=d);
  for(let i=0;i<100;i++){if(child.exitCode!==null)throw new Error(logs);try{if((await fetch(`${base}/health`)).ok)return;}catch{}await new Promise(r=>setTimeout(r,50));}throw new Error('API unavailable');
}
async function stop(){const done=new Promise(r=>child.once('exit',r));child.kill('SIGTERM');await done;}
async function json(path){const r=await fetch(base+path);return{status:r.status,body:await r.json()};}
try{
  await start();db=new Database(dbPath);
  assert.deepEqual((await json('/history')).body,{items:[],total:0,filtered_total:0,page:1,page_size:20,pages:0});
  const ids=seedHistory(db);
  let result=await json('/history');assert.equal(result.status,200);assert.equal(result.body.items.length,20);assert.equal(result.body.total,26);assert.equal(result.body.pages,2);
  const first=result.body.items.map(r=>r.id);
  result=await json('/history?page=2');assert.equal(result.body.items.length,6);assert.equal(result.body.items.some(r=>first.includes(r.id)),false);
  assert.equal((await json('/history?page=999')).body.page,2);
  assert.equal((await json('/history?sort=oldest&page_size=10')).body.items[0].id,ids.empty);
  assert.equal((await json('/history?q=ssd')).body.filtered_total,3);
  assert.equal((await json('/history?q=100%25')).body.filtered_total,1);
  assert.equal((await json('/history?q=_test')).body.filtered_total,1);
  assert.equal((await json('/history?q=missing')).body.filtered_total,0);
  const combined=(await json('/history?q=SSD&status='+encodeURIComponent('comparação'))).body;
  assert.equal(combined.filtered_total,1);assert.equal(combined.items[0].id,ids.partial);assert.equal(combined.items[0].partial_quote_count,1);assert.equal(combined.items[0].selected_tco_cents,null);
  const period=(await json('/history?created_from=2026-11-02T00%3A00%3A00.000Z&created_before=2026-11-04T00%3A00%3A00.000Z')).body;
  assert.equal(period.filtered_total,2);
  const chosen=(await json('/history?q=SSD&status=decidida')).body.items[0];assert.equal(chosen.selected_supplier,'Fornecedor escolhido');assert.equal(chosen.selected_tco_cents,21000);assert.equal(chosen.last_activity_at,'2026-11-03T16:00:00.000Z');
  const empty=(await json('/history/'+ids.empty)).body;assert.equal(empty.quotes.length,0);assert.equal(empty.conversations.length,0);assert.equal(empty.timeline.length,1);
  const partial=(await json('/history/'+ids.partial)).body;assert.equal(partial.quotes[0].eligible,false);assert.equal(partial.quotes[0].tco_cents,null);assert.ok(partial.quotes[0].eligibility_reasons.includes('frete pendente'));
  const detail=(await json('/history/'+ids.decided)).body;assert.equal(detail.quotes[0].selected,true);assert.equal(detail.decision_at,null);assert.equal(detail.conversations.length,3);
  assert.deepEqual(detail.conversations.map(g=>g.messages.length),[1,1,1]);assert.deepEqual(new Set(detail.conversations.map(g=>g.channel)),new Set(['whatsapp','telegram']));
  assert.equal(detail.conversations[0].contact_name,'Contato A');assert.equal(detail.conversations[1].contact_name,'Contato B');
  assert.equal(detail.timeline.some(e=>e.kind==='decision'||e.kind==='status'),false);assert.match(detail.timeline_limitations,/não foram registradas/);
  const serialized=JSON.stringify(detail);assert.doesNotMatch(serialized,/must-not-leak|chat_id|external_message_id|5511999999999|execution_version|event_id/);
  assert.equal((await json('/requests')).body.length,26);assert.equal((await json('/requests/'+ids.decided+'/messages')).body.length,3);
  for(const query of ['page=0','page=1.5','page_size=101','status=INVALID','sort=DROP','created_from=nope','created_from=2026-02-30T00:00:00.000Z','created_from=2026-11-05T00:00:00.000Z&created_before=2026-11-01T00:00:00.000Z'])assert.equal((await json('/history?'+query)).status,400,query);
  assert.equal((await json('/history/00000000-0000-0000-0000-000000000000')).status,404);
  const before=db.prepare('SELECT count(*) AS count FROM requests').get();await stop();await start();assert.equal((await json('/history')).body.total,before.count);assert.equal((await json('/history/'+ids.decided)).body.quotes[0].tco_cents,21000);
  console.log('PASS history HTTP: persisted requests, search/literal escaping, filters/dates, sort/pagination, partial/decided TCO, contact isolation, factual timeline, redaction, restart and existing contracts');
}catch(e){console.error(e);console.error(logs);process.exitCode=1;}
finally{if(child?.exitCode===null)await stop();db?.close();rmSync(dir,{recursive:true,force:true});}
