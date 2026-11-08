import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import Database from 'better-sqlite3';
import {TextNegotiation,targetUnitCents} from '../dist/text-negotiation.js';
import {configureWhatsAppWebhook,configureTelegramWebhook,refreshPublicOrigin} from '../dist/runtime-integrations.js';
const db=new Database(':memory:');
const policy=new TextNegotiation(db);
const req={id:'policy-test',qty:2,quotes:[{source_url:'https://market.example/item',unit_cents:12000},{source_url:'https://market.example/other',unit_cents:10000}]};
const terms={unit_cents:11000,shipping_cents:500,fees_cents:0,lead_days:3,available_qty:10};
assert.equal(targetUnitCents(req,11000),8000);
for(const channel of ['whatsapp','telegram']){
 for(let round=1;round<=3;round++){
  assert.equal(policy.turn(req,channel,'supplier',terms,false,String(round)).negotiating,true);
  policy.turn(req,channel,'supplier',terms,false,String(round));
  assert.equal(policy.state(req.id,channel,'supplier').rounds,round,'replaying an event cannot consume another round');
 }
 assert.equal(policy.turn(req,channel,'supplier',terms,false,'4').negotiating,false);
 assert.equal(policy.accept(req.id,channel,'supplier',true),null,'finished offers cannot be replaced by stale acceptance');
 assert.match(policy.turn(req,channel,'supplier',terms,false,'5').reply,/Confirma essas condições/);
}
assert.equal(policy.turn({...req,id:'final'},'whatsapp','supplier',terms,true,'1').negotiating,false,'explicit final supplier offer ends counteroffers');
assert.equal(policy.accept(req.id,'whatsapp','missing',true,'Consigo sim'),null,'no acceptance without an active counteroffer');
policy.turn({...req,id:'affirmative'},'whatsapp','supplier',terms,false,'1');
for(const message of ['Consigo sim','Consigo ss','Sim','Aceito a contraproposta','De acordo'])assert.equal(policy.accept('affirmative','whatsapp','supplier',false,message),8000);
for(const message of ['Não consigo','Sim, mas o frete muda','Sim, temos estoque','Talvez'])assert.equal(policy.accept('affirmative','whatsapp','supplier',false,message),null);
assert.equal(targetUnitCents({quotes:[]},10001),8001,'integer-cent rounding');
for(const channel of ['whatsapp','telegram']) {
 const r={id:`counter-${channel}`,qty:1,quotes:[]};
 const initial={...terms,unit_cents:715000};
 assert.match(policy.turn(r,channel,'seller',initial,false,'1').reply,/5720.00/);
 const revised={...initial,unit_cents:620000};
 const counter=policy.turn(r,channel,'seller',revised,false,'2','Consigo 6200');
 assert.match(counter.reply,/6200.00.*5960.00/,'acknowledge new supplier price and change buyer counteroffer');
 assert.equal(policy.accept(r.id,channel,'seller',true,'Consigo 6200'),null,'a new amount never accepts the previous buyer price');
 assert.equal(policy.accept(r.id,channel,'seller',true,'Consigo 6200',620000),null,'typed acceptance cannot replace a different supplier counteroffer');
 assert.equal(policy.accept(r.id,channel,'seller',true,'Aceito R$5960',596000),596000,'explicit acceptance at the current price is supported');
 assert.equal(policy.accept(r.id,channel,'seller',false,'Consigo sim'),596000,'acceptance uses the latest counteroffer');
 const refusal=policy.turn(r,channel,'seller',revised,false,'3','Não consigo');
 assert.equal(refusal.negotiating,false);
 assert.match(refusal.reply,/respeitar seu limite.*6200.00.*Confirma essas condições/);
 assert.equal(policy.state(r.id,channel,'seller').finished,1);
}
const calls=[];let forceDns=false;
const fake=createServer(async(req,res)=>{
 let raw='';for await(const chunk of req)raw+=chunk;
 calls.push({url:req.url,body:raw?JSON.parse(raw):null,headers:req.headers});
 res.setHeader('content-type','application/json');
 if(req.url==='/metrics'){res.end('cloudflared_tunnel_user_hostnames_counts{userHostname="https://nexo-test.trycloudflare.com"} 1');return;}
 if(req.url.startsWith('/instance/connectionState')){res.end('{"instance":{"state":"open"}}');return;}
 if(forceDns && req.url==='/botfake-token/setWebhook' && !JSON.parse(raw).ip_address){res.statusCode=400;res.end(JSON.stringify({ok:false,description:'Bad Request: bad webhook: Failed to resolve host: Name or service not known'}));return;}
 res.end('{"ok":true}');
});
await new Promise(r=>fake.listen(0,'127.0.0.1',r));
const origin=`http://127.0.0.1:${fake.address().port}`;
Object.assign(process.env,{WHATSAPP_API_URL:origin,WHATSAPP_API_KEY:'fake-key',WHATSAPP_WEBHOOK_SECRET:'fake-secret',WHATSAPP_INSTANCE_NAME:'nexo',TELEGRAM_BOT_TOKEN:'fake-token',TELEGRAM_WEBHOOK_SECRET:'fake-tg-secret',TELEGRAM_API_URL:origin,TUNNEL_METRICS_URL:`${origin}/metrics`});
try{
 assert.equal(await configureWhatsAppWebhook(),true);
 const webhook=calls.find(c=>c.url==='/webhook/set/nexo').body.webhook;
 assert.equal(webhook.url,'http://api:4000/webhook/whatsapp');assert.equal(webhook.headers['x-whatsapp-webhook-secret'],'fake-secret');assert.deepEqual(webhook.events,['MESSAGES_UPSERT']);
 assert.equal(await refreshPublicOrigin(),'https://nexo-test.trycloudflare.com');
 assert.equal(await configureTelegramWebhook(),true);
 const telegram=calls.find(c=>c.url==='/botfake-token/setWebhook').body;
 forceDns=true;assert.equal(await configureTelegramWebhook(async()=>({address:'104.16.231.132'})),true);assert.equal(calls.at(-1).body.ip_address,'104.16.231.132');
 assert.equal(telegram.url,'https://nexo-test.trycloudflare.com/api/webhook/telegram');assert.equal(telegram.secret_token,'fake-tg-secret');
 console.log('PASS shared negotiation policy: three rounds, event replay, final offers, market target; Docker-internal authenticated WhatsApp webhook and HTTPS Telegram setup.');
}finally{db.close();await new Promise(r=>fake.close(r));}
