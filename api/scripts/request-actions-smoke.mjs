// HTTP integration checks against a disposable SQLite database and local channel/agent stubs.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
const Database = createRequire(import.meta.url)('better-sqlite3');
const dir = mkdtempSync(join(tmpdir(), 'nexo-actions-'));
const tasks = [], sends = [];
let delayInterpretation, delaySend, releaseInterpretation, releaseSend, startedInterpretation, startedSend;
const stub = createServer(async (req, res) => {
  const chunks=[]; for await (const chunk of req) chunks.push(chunk);
  const body=JSON.parse(Buffer.concat(chunks).toString() || '{}');
  let result={};
  if (req.url === '/tasks') { tasks.push(body); result={accepted:true}; }
  else if (req.url === '/interpret-quote') {
    startedInterpretation?.();
    if (delayInterpretation) await new Promise(resolve => {releaseInterpretation=resolve;});
    result={unit_cents:null,pending:['frete']};
  } else if (req.url.includes('/sendMessage')) {
    sends.push(body); startedSend?.();
    if (delaySend) await new Promise(resolve => {releaseSend=resolve;});
    result={ok:true,result:{message_id:sends.length}};
  } else if (req.url.startsWith('/message/sendText/')) { sends.push(body); result={key:{id:'wa-stub'}}; }
  else { res.statusCode=404; }
  res.setHeader('Content-Type','application/json');res.end(JSON.stringify(result));
});
await new Promise(r=>stub.listen(0,'127.0.0.1',r));
const stubUrl=`http://127.0.0.1:${stub.address().port}`;
const probe=createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
const base=`http://127.0.0.1:${port}`,dbPath=join(dir,'actions.sqlite');
let child,db,logs='';
const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function within(promise,label){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Timeout: '+label)),5000);})]);}finally{clearTimeout(timer);}}
async function api(path,method='GET',body){const response=await fetch(base+path,{method,headers:{'content-type':'application/json',authorization:'Bearer test-internal','x-telegram-bot-api-secret-token':'test-telegram','x-whatsapp-webhook-secret':'test-whatsapp'},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:response.status,body:await response.json()};}
async function start(){
  child=spawn(process.execPath,['dist/main.js'],{stdio:['ignore','pipe','pipe'],env:{...process.env,PORT:String(port),DATABASE_PATH:dbPath,AGENT_URL:stubUrl,TELEGRAM_API_URL:stubUrl,TELEGRAM_BOT_TOKEN:'stub-only',TELEGRAM_ALLOWED_CHAT_IDS:'12345',TELEGRAM_WEBHOOK_SECRET:'test-telegram',WHATSAPP_API_URL:stubUrl,WHATSAPP_API_KEY:'stub-only',WHATSAPP_WEBHOOK_SECRET:'test-whatsapp',WHATSAPP_INSTANCE_NAME:'nexo',INTERNAL_API_TOKEN:'test-internal'}});
  child.stdout.on('data',d=>logs+=d);child.stderr.on('data',d=>logs+=d);
  for(let i=0;i<100;i++){if(child.exitCode!==null)throw new Error(logs);try{if((await fetch(base+'/health')).ok)return;}catch{}await wait(50);}throw new Error('API unavailable');
}
async function stop(){const done=new Promise(r=>child.once('exit',r));child.kill();await done;}
const tables=['requests','quotes','tasks','conversation_messages','telegram_delivery','telegram_outbound','contact_idempotency','whatsapp_contacts','whatsapp_delivery','whatsapp_updates','whatsapp_quote_state','whatsapp_voice_calls'];
function count(table,id){return db.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${table==='requests'?'id':'request_id'}=?`).get(id).n;}
function assertGone(id){for(const table of tables)assert.equal(count(table,id),0,table);}
try {
  await start();db=new Database(dbPath);
  const original=(await api('/requests','POST',{product:'SSD ciclo independente',specs:{capacidade:'1 TB'},qty:2,destination:'01001-000'})).body;
  assert.equal(original.status,'pesquisando');
  const quoted=(await api(`/requests/${original.id}/quotes`,'POST',{supplier:'Fornecedor',unit_cents:10000,shipping_cents:100,fees_cents:0,lead_days:2,available_qty:5,product_confirmed:true,destination_confirmed:true,event_id:'original-quote'})).body;
  assert.equal((await api(`/requests/${original.id}/decision`,'POST',{quote_id:quoted.quotes[0].id,version:quoted.version})).status,201);
  const before=(await api(`/requests/${original.id}`)).body;
  const repeated=await api(`/requests/${original.id}/repeat`,'POST',{});
  assert.equal(repeated.status,201);assert.notEqual(repeated.body.id,original.id);
  for(const field of ['product','specs','qty','destination'])assert.deepEqual(repeated.body[field],original[field]);
  assert.equal(repeated.body.decision,null);assert.equal(repeated.body.agent_analysis,null);assert.deepEqual(repeated.body.quotes,[]);assert.equal(repeated.body.notice,null);
  assert.equal(count('tasks',repeated.body.id),1);assert.equal(count('whatsapp_contacts',repeated.body.id),0);
  assert.equal(count('conversation_messages',repeated.body.id),1); // New Telegram notification, never an inherited message.
  assert.notEqual(tasks[0].task_id,tasks[1].task_id);assert.equal(tasks[1].request_id,repeated.body.id);assert.deepEqual(tasks[1].specs,original.specs);
  assert.equal(tasks[1].execution_version,1);assert.deepEqual((await api(`/requests/${original.id}`)).body,before);
  const overridden=await api(`/requests/${repeated.body.id}/repeat`,'POST',{qty:4,destination:'15000-000'});
  assert.equal(overridden.status,201);assert.equal(overridden.body.qty,4);assert.equal(overridden.body.destination,'15000-000');assert.equal(tasks.at(-1).qty,4);
  const total=db.prepare('SELECT count(*) AS n FROM requests').get().n;
  for(const invalid of [{qty:0},{qty:1.5},{qty:null},{destination:''},{destination:null},{product:'override'},[],null])assert.equal((await api(`/requests/${original.id}/repeat`,'POST',invalid)).status,400);
  assert.equal(db.prepare('SELECT count(*) AS n FROM requests').get().n,total);
  db.exec("CREATE TRIGGER block_task BEFORE INSERT ON tasks BEGIN SELECT RAISE(ABORT,'test atomic creation'); END");
  assert.equal((await api(`/requests/${original.id}/repeat`,'POST',{})).status,500);
  assert.equal(db.prepare('SELECT count(*) AS n FROM requests').get().n,total);
  db.exec('DROP TRIGGER block_task');
  const deletedParent=db.prepare('SELECT message_id FROM telegram_outbound WHERE request_id=?').get(original.id).message_id;
  const id=original.id,now=new Date().toISOString();
  db.prepare('INSERT INTO contact_idempotency VALUES(?,?,?,?)').run(id,'key','{}',now);
  db.prepare('INSERT INTO whatsapp_contacts VALUES(?,?,?,?)').run(id,'supplier','Contato','5511999999999');
  db.prepare('INSERT INTO whatsapp_delivery VALUES(?,?,?,?,?,?,?,?)').run('delivery',id,'5511999999999','text','sent','external',null,now);
  db.prepare('INSERT INTO whatsapp_updates VALUES(?,?,?,?,?,?,?,?,?,?)').run('update',id,'5511999999999','supplier','text','processed',1,null,null,now);
  db.prepare('INSERT INTO whatsapp_quote_state VALUES(?,?,?)').run(id,'5511999999999','{}');
  db.prepare('INSERT INTO whatsapp_voice_calls VALUES(?,?,?,?)').run('voice',id,'supplier',0);
  db.prepare('INSERT INTO telegram_updates(update_id,received_at,status) VALUES(?,?,?)').run(999,now,'processed');
  db.prepare('INSERT INTO conversation_messages(id,request_id,chat_id,sender_type,content,update_id,created_at) VALUES(?,?,?,?,?,?,?)').run(randomUUID(),id,'12345','SUPPLIER','original only',999,now);
  // A forced final delete failure must roll back every dependent delete.
  db.exec(`CREATE TRIGGER block_delete BEFORE DELETE ON requests WHEN OLD.id='${id}' BEGIN SELECT RAISE(ABORT,'test rollback'); END`);
  const counts=tables.map(table=>count(table,id));
  assert.equal((await api('/requests/'+id,'DELETE')).status,500);
  assert.deepEqual(tables.map(table=>count(table,id)),counts);assert.ok(db.prepare('SELECT 1 FROM telegram_updates WHERE update_id=999').get());
  db.exec('DROP TRIGGER block_delete');
  const siblingCounts=tables.map(table=>count(table,repeated.body.id));
  assert.deepEqual(await api('/requests/'+id,'DELETE'),{status:200,body:{ok:true,id}});assertGone(id);
  assert.equal(db.prepare('SELECT 1 FROM telegram_updates WHERE update_id=999').get(),undefined);
  assert.deepEqual(tables.map(table=>count(table,repeated.body.id)),siblingCounts);
  assert.equal((await api('/requests/'+id)).status,404);assert.equal((await api('/history/'+id)).status,404);
  assert.equal((await api('/requests/'+id,'DELETE')).status,404);
  assert.equal((await api('/requests/'+id+'/repeat','POST',{})).status,404);
  assert.equal((await api('/tasks/'+tasks[0].task_id+'/result','POST',{status:'completed',execution_version:1,quotes:[]})).status,404);
  const lateTelegram=await api('/webhook/telegram','POST',{update_id:1000,message:{chat:{id:12345},from:{id:12345},text:'Resposta à solicitação excluída',reply_to_message:{message_id:deletedParent}}});
  assert.equal(lateTelegram.body.ignored,'unknown-reply');
  const lateWhatsApp=await api('/webhook/whatsapp','POST',{instance:'nexo',event:'messages.upsert',data:{key:{fromMe:false,id:'deleted-parent',remoteJid:'5511999999999@s.whatsapp.net'},message:{extendedTextMessage:{text:'Resposta antiga',contextInfo:{stanzaId:'external'}}}}});
  assert.equal(lateWhatsApp.body.ignored,'unknown-reply');
  // Deletion while a Telegram send is pending must not recreate outbound or conversation rows.
  delaySend=true; const sendStarted=new Promise(r=>{startedSend=r;});
  const creation=api('/requests','POST',{product:'Envio em andamento',specs:{},qty:1,destination:'01001-000'});
  await within(sendStarted,'Telegram send');const sendingId=tasks.at(-1).request_id;
  assert.equal((await api('/requests/'+sendingId,'DELETE')).status,200);releaseSend();await creation;assertGone(sendingId);
  delaySend=false;startedSend=null;
  // Deletion while each channel waits on interpretation must drop the delayed result.
  for (const channel of ['telegram','whatsapp']) {
    const request=(await api('/requests','POST',{product:'Interpretação '+channel,specs:{},qty:1,destination:'01001-000'})).body;
    let payload,path;
    if(channel==='telegram') {
      const parent=db.prepare('SELECT message_id FROM telegram_outbound WHERE request_id=?').get(request.id).message_id;
      path='/webhook/telegram';payload={update_id:1001,message:{message_id:1002,chat:{id:12345},from:{id:12345,first_name:'Fornecedor'},text:'Ainda verificando',reply_to_message:{message_id:parent}}};
    } else {
      db.prepare('INSERT INTO whatsapp_contacts VALUES(?,?,?,?)').run(request.id,'supplier','Contato','5511999999999');
      db.prepare('INSERT INTO whatsapp_delivery VALUES(?,?,?,?,?,?,?,?)').run(randomUUID(),request.id,'5511999999999','text','sent','wa-parent',null,now);
      path='/webhook/whatsapp';payload={instance:'nexo',event:'messages.upsert',data:{key:{fromMe:false,id:'late-result',remoteJid:'5511999999999@s.whatsapp.net'},message:{conversation:'Ainda verificando'}}};
    }
    delayInterpretation=true; const interpretationStarted=new Promise(r=>{startedInterpretation=r;});
    const pending=api(path,'POST',payload);await within(interpretationStarted,channel+' interpretation');
    const sendCount=sends.length;await api('/requests/'+request.id,'DELETE');releaseInterpretation();
    assert.equal((await pending).status,200);assertGone(request.id);assert.equal(sends.length,sendCount);
    delayInterpretation=false;startedInterpretation=null;
  }
  const survivor=repeated.body.id;
  await stop();await start();assert.equal((await api('/requests/'+survivor)).status,200);assert.equal((await api('/requests/'+id)).status,404);
  console.log('PASS request actions: repeat/defaults/overrides/validation/new agent task, original immutable, atomic rollback, all dependencies removed, siblings preserved, late callbacks/sends/interpretations do not resurrect requests, restart persistence');
} catch(error) {console.error(error);console.error(logs);process.exitCode=1;}
finally {releaseInterpretation?.();releaseSend?.();if(child?.exitCode===null)await stop();db?.close();await new Promise(r=>stub.close(r));rmSync(dir,{recursive:true,force:true});}
