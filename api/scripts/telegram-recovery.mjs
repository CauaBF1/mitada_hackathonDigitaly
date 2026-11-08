import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {mkdtempSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRequire} from 'node:module';
const Database=createRequire(import.meta.url)('better-sqlite3');
const dir=mkdtempSync(join(tmpdir(),'nexo-telegram-recovery-'));
const dbPath=join(dir,'business.sqlite');
// Accelerate the old lock timeout only, to expose early unlock without a 42s test.
const preload=join(dir,'timer.cjs');
writeFileSync(preload,'const timer=global.setTimeout;global.setTimeout=(fn,ms,...args)=>timer(fn,ms===42000?10:ms,...args);');
let active=0,maxActive=0,sends=0,turns=0,child,db,logs='',telegramMode='ok';
const agent=createServer(async(req,res)=>{
 let raw='';for await(const chunk of req)raw+=chunk;
 const body=JSON.parse(raw||'{}');
 if(req.url!=='/conversation-turn'){res.writeHead(202).end('{"accepted":true}');return;}
 if(body.phase!=='opening'){
  turns++;active++;maxActive=Math.max(maxActive,active);
  await new Promise(resolve=>setTimeout(resolve,80));active--;
 }
 const pending=body.message==='recover-pending'&&turns===1;
 res.setHeader('content-type','application/json');
 res.end(JSON.stringify({intent:pending?'pending':'quotation',reply:pending?'Sua mensagem foi recebida e está com processamento pendente.':'Resposta final de teste.',terms:null,explicit_confirmation:false,terms_changed:false,purchase_acceptance:'unclear'}));
});
const telegram=createServer(async(req,res)=>{
 for await(const _ of req){};sends++;
 if(telegramMode==='server-error'){res.writeHead(503,{'content-type':'application/json'}).end('{"ok":false}');return;}
 if(telegramMode==='missing-id'){res.writeHead(200,{'content-type':'application/json'}).end('{"ok":true,"result":{}}');return;}
 res.setHeader('content-type','application/json');res.end(JSON.stringify({ok:true,result:{message_id:100+sends}}));
});
await new Promise(r=>agent.listen(0,'127.0.0.1',r));
await new Promise(r=>telegram.listen(0,'127.0.0.1',r));
const listener=createServer();await new Promise(r=>listener.listen(0,'127.0.0.1',r));
const port=listener.address().port;await new Promise(r=>listener.close(r));
const base=`http://127.0.0.1:${port}`;
const env={...process.env,PORT:String(port),DATABASE_PATH:dbPath,AGENT_URL:`http://127.0.0.1:${agent.address().port}`,INTERNAL_API_TOKEN:'test-only-token',TELEGRAM_API_URL:`http://127.0.0.1:${telegram.address().port}`,TELEGRAM_BOT_TOKEN:'test-only',TELEGRAM_ALLOWED_CHAT_IDS:'12345',TELEGRAM_WEBHOOK_SECRET:'test-secret'};
async function start(){
 child=spawn(process.execPath,['--require',preload,'dist/main.js'],{cwd:new URL('..',import.meta.url),env,stdio:['ignore','pipe','pipe']});
 child.stdout.on('data',x=>logs+=x);child.stderr.on('data',x=>logs+=x);
 await until(async()=>{try{return (await fetch(base+'/health')).ok;}catch{return false;}},'API ready');
}
async function stop(){const done=once(child,'exit');child.kill('SIGTERM');await done;}
async function until(fn,label){for(let i=0;i<150;i++){if(await fn())return;await new Promise(r=>setTimeout(r,100));}throw new Error(`${label}: ${logs}`);}
async function post(path,body){const res=await fetch(base+path,{method:'POST',headers:{'content-type':'application/json','x-telegram-bot-api-secret-token':'test-secret'},body:JSON.stringify(body)});const data=await res.json();assert.ok(res.ok,JSON.stringify(data));return data;}
try{
 await start();db=new Database(dbPath);
 const req=await post('/requests',{product:'Item recovery',specs:{},qty:1,destination:'01001-000'});
 await until(()=>db.prepare('SELECT 1 FROM telegram_outbound WHERE request_id=?').get(req.id),'opening sent');
 const parent=db.prepare('SELECT message_id FROM telegram_outbound WHERE request_id=?').get(req.id).message_id;
 const update={update_id:7001,message:{message_id:7001,text:'recover-pending',chat:{id:12345},from:{id:12345},reply_to_message:{message_id:Number(parent)}}};
 const baseline=sends;
 assert.equal((await post('/webhook/telegram',update)).pending,true);
 assert.equal(sends,baseline,'pending interpretation must not create a terminal placeholder delivery');
 assert.equal(db.prepare('SELECT count(*) n FROM telegram_delivery WHERE source_update_id=7001').get().n,0);
 // Simulate an interrupted interpretation, then exercise actual startup recovery.
 await stop();
 db.prepare("UPDATE telegram_updates SET status='processing',retry_after=? WHERE update_id=7001").run(new Date(Date.now()+60000).toISOString());
 await start();
 await until(()=>db.prepare('SELECT status FROM telegram_updates WHERE update_id=7001').get().status==='processed','restart recovery');
 assert.equal(sends,baseline+1);
 assert.equal(db.prepare('SELECT attempts FROM telegram_updates WHERE update_id=7001').get().attempts,2);
 await post('/webhook/telegram',update);assert.equal(sends,baseline+1,'duplicate must not resend');
 maxActive=0;
 await Promise.all([post(`/requests/${req.id}/conversation-turn`,{message:'slow-one',chat_id:'12345'}),post(`/requests/${req.id}/conversation-turn`,{message:'slow-two',chat_id:'12345'})]);
 assert.equal(maxActive,1,'lock must remain held until the underlying turn has settled');
 // Delivery already in flight at crash is uncertain and must not be resubmitted.
 await stop();
 const uncertainUpdate={...update,update_id:7002,message:{...update.message,message_id:7002,text:'uncertain'}};
 db.prepare("INSERT INTO telegram_updates(update_id,received_at,raw_update,status,attempts) VALUES(?,?,?,'processing',1)").run(7002,new Date().toISOString(),JSON.stringify(uncertainUpdate));
 db.prepare("INSERT INTO telegram_delivery(id,request_id,chat_id,status,created_at,message_text,source_update_id) VALUES('crash-delivery',?,'12345','sending',?,'already in flight',7002)").run(req.id,new Date().toISOString());
 const oldUpdate={...update,update_id:7003,message:{message_id:7003,text:'old unbound message',chat:{id:12345},from:{id:12345}}};
 db.prepare("INSERT INTO telegram_updates(update_id,received_at,raw_update,status,attempts) VALUES(?,?,?,'processing',1)").run(7003,new Date(Date.now()-86400000).toISOString(),JSON.stringify(oldUpdate));
 const before=sends;await start();
 await until(()=>db.prepare('SELECT status FROM telegram_updates WHERE update_id=7003').get().status==='exhausted','unbound historical quarantine');
 assert.equal(db.prepare('SELECT count(*) n FROM conversation_messages WHERE update_id=7003').get().n,0);

 assert.equal(db.prepare("SELECT status FROM telegram_delivery WHERE id='crash-delivery'").get().status,'uncertain');
 assert.equal(db.prepare('SELECT status FROM telegram_updates WHERE update_id=7002').get().status,'processed');
 await post('/webhook/telegram',uncertainUpdate);assert.equal(sends,before);
 for(const mode of ['server-error','missing-id']){
  telegramMode=mode;
  const id=mode==='server-error'?7004:7005;
  await post('/webhook/telegram',{...update,update_id:id,message:{...update.message,message_id:id,text:mode}});
  assert.equal(db.prepare('SELECT status FROM telegram_delivery WHERE source_update_id=?').get(id).status,'uncertain');
  const count=sends;
  await post('/webhook/telegram',{...update,update_id:id,message:{...update.message,message_id:id,text:mode}});
  assert.equal(sends,count,'uncertain server response must not resend');
 }
 console.log('PASS Telegram recovery: pending → restart → final reply, dedupe, serialized slow turns, uncertain delivery suppression');
}finally{
 if(child?.exitCode===null)await stop();db?.close();
 await Promise.all([new Promise(r=>agent.close(r)),new Promise(r=>telegram.close(r))]);rmSync(dir,{recursive:true,force:true});
}
