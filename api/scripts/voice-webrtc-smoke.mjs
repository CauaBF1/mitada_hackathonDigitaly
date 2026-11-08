import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'nexo-voice-webrtc-'));
const dbPath = join(dir, 'business.sqlite');
const waSends = [];
const tgSends = [];
let db, parseDelay=0, providerCall=null;
const turns=[];

const fake = createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const body = raw ? JSON.parse(raw) : {};
  res.setHeader('content-type', 'application/json');
  if (req.url === '/tasks') {
    res.writeHead(202).end('{"accepted":true}');
    return;
  }
  if (req.url?.includes('/sendMessage')) {
    tgSends.push(body);
    res.end(JSON.stringify({ ok: true, result: { message_id: tgSends.length } }));
    return;
  }
  if (req.url === '/message/sendText/nexo') {
    waSends.push(body);
    res.end(JSON.stringify({ key: { id: `wa-${waSends.length}` } }));
    return;
  }
  if(providerCall && req.url===`/call/${providerCall.id}`){res.end(JSON.stringify(providerCall));return;}
  if(req.url==='/conversation-turn'){
    turns.push(body);if(parseDelay)await new Promise(r=>setTimeout(r,parseDelay));
    const terms=body.terms||{supplier:'Fornecedor de teste',unit_cents:10000,shipping_cents:0,fees_cents:0,lead_days:7,available_qty:10,product_confirmed:true,destination_confirmed:true};
    res.end(JSON.stringify({intent:'quotation',reply:'Termos recebidos.',terms,explicit_confirmation:body.phase==='quote_confirmation',terms_changed:false,purchase_acceptance:'unclear',accepted_counter_offer:body.message==='Aceito a contraproposta',offer_is_final:body.message==='Este é o preço final'}));return;
  }
  res.writeHead(404).end('{}');
});

await new Promise((resolve) => fake.listen(0, '127.0.0.1', resolve));
const fakeUrl = `http://127.0.0.1:${fake.address().port}`;
const portServer = createServer();
await new Promise((resolve) => portServer.listen(0, '127.0.0.1', resolve));
const port = portServer.address().port;
await new Promise((resolve) => portServer.close(resolve));
const base = `http://127.0.0.1:${port}`;

let child;
let logs = '';
async function start(voiceWait = '120') {
  child = spawn(process.execPath, ['dist/main.js'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PORT: String(port),VOICE_ANSWER_TIMEOUT_SECONDS:voiceWait,
      DATABASE_PATH: dbPath,
      AGENT_URL: fakeUrl,
      INTERNAL_API_TOKEN: 'internal-test',
      PUBLIC_APP_URL: 'http://localhost:3000',
      TELEGRAM_API_URL: fakeUrl,
      TELEGRAM_BOT_TOKEN: 'tg-bot-token',
      TELEGRAM_ALLOWED_CHAT_IDS: '998877',
      TELEGRAM_WEBHOOK_SECRET: 'tg-secret',
      WHATSAPP_API_URL: fakeUrl,
      WHATSAPP_API_KEY: 'evolution-test',
      WHATSAPP_INSTANCE_NAME: 'nexo',
      WHATSAPP_WEBHOOK_SECRET: 'wa-secret',
      VOICE_WEBHOOK_SECRET: 'voice-secret',
      VAPI_API_KEY: 'vapi-private-must-not-leak',VAPI_API_URL:fakeUrl,
      VAPI_PUBLIC_KEY:'vapi-pub-test',WHATSAPP_TEST_SUPPLIER_NUMBER:'5517991636725',AUTO_CONFIGURE_INTEGRATIONS:'false',
      VAPI_ASSISTANT_ID: 'vapi-asst-test',
    },
  });
  child.stdout.on('data', (d) => (logs += d));
  child.stderr.on('data', (d) => (logs += d));
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error(logs);
    try {
      if ((await fetch(`${base}/health`)).ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('API did not start');
}

async function stop() {
  const done = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGTERM');
  await done;
}

async function json(path, body, headers = {}) {
  const r = await fetch(`${base}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
}

async function until(predicate){for(let i=0;i<150;i++){if(predicate())return;await new Promise(r=>setTimeout(r,50));}throw new Error('Worker timeout');}
async function create(product='Mouse teste'){
  const result=await json('/requests',{product,qty:2,destination:'01001-000',specs:{}});
  assert.equal(result.status,201);const id=result.body.id;
  await until(()=>db.prepare('SELECT status FROM whatsapp_contact_flow WHERE request_id=?').get(id)?.status==='voice_waiting');
  return id;
}
function flow(id){return db.prepare('SELECT * FROM whatsapp_contact_flow WHERE request_id=?').get(id);}
function expire(id){db.prepare('UPDATE whatsapp_contact_flow SET next_check_at=? WHERE request_id=?').run(new Date(Date.now()-1).toISOString(),id);}
async function reply(id,key,text,number='551791636725'){
  const parent=db.prepare("SELECT message_id FROM whatsapp_delivery WHERE request_id=? AND status='sent' ORDER BY rowid LIMIT 1").get(id).message_id;
  return json('/webhook/whatsapp',{event:'messages.upsert',instance:'nexo',data:{key:{id:key,remoteJid:'987654321@lid',remoteJidAlt:`${number}@s.whatsapp.net`,fromMe:false},message:{extendedTextMessage:{text,contextInfo:{stanzaId:parent}}}}},{'x-whatsapp-webhook-secret':'wa-secret'});
}
try {
  await start();db=new Database(dbPath);
  const id=await create();
  assert.match(waSends.at(-1).text,new RegExp(`/call/${id}`));assert.equal(tgSends.length,0);
  const sentAt=Date.parse(db.prepare('SELECT created_at FROM whatsapp_delivery WHERE request_id=?').get(id).created_at);
  assert.ok(Date.parse(flow(id).next_check_at)-sentAt>=119000,'voice waits 120 seconds by default');
  const session=(await json(`/call-session/${id}`)).body;
  assert.equal(session.vapi_public_key,'vapi-pub-test');assert.ok(session.voice_webhook_token);assert.ok(!JSON.stringify(session).includes('vapi-private'));
  const forbidden=await json('/webhook/voice',{request_id:id,supplier_id:'teste-whatsapp',call_id:'unauth',status:'failed'});
  assert.equal(forbidden.status,401);
  // Expiring persisted deadlines models elapsed time, without sleeping for three minutes.
  expire(id);await stop();await start();
  await until(()=>flow(id).status==='wa_waiting');assert.equal(waSends.length,2);assert.equal(tgSends.length,0);
  const waAt=Date.parse(db.prepare("SELECT created_at FROM whatsapp_delivery WHERE request_id=? ORDER BY rowid DESC LIMIT 1").get(id).created_at);
  assert.ok(Date.parse(flow(id).next_check_at)-waAt>=59000,'WhatsApp waits 60 seconds');
  const sendsBefore=waSends.length;
  expire(id);await stop();await start();await until(()=>tgSends.length===1);
  assert.equal(waSends.length,sendsBefore,'restart does not resend invitations or WhatsApp text');
  assert.equal((await json(`/call-session/${id}/start`,{call_id:'late-call'})).body.ok,false,'late call cannot interrupt text contact');
  // A WhatsApp reply wins before interpretation finishes, also with Brazil ninth digit / LID aliases.
  const telegramReply=(update_id,text)=>json('/webhook/telegram',{update_id,message:{message_id:5000+update_id,chat:{id:998877},from:{id:998877},text,reply_to_message:{message_id:1}}},{'x-telegram-bot-api-secret-token':'tg-secret'});
  await telegramReply(1,'Preço 100, frete zero, taxas zero, 7 dias, estoque 10.');
  assert.match(tgSends.at(-1).text,/80.00/);
  await telegramReply(2,'Consigo sim');assert.equal((await json(`/requests/${id}`)).body.quote_completion_state,'concluida','accepting the exact counteroffer completes the quote without another yes');
  await telegramReply(3,'Confirmo');assert.equal((await json(`/requests/${id}`)).body.quote_completion_state,'concluida');
  const telegramCount=tgSends.length;
  const responding=await create();parseDelay=900;
  const pending=reply(responding,'response-1','Preço 100, frete e taxas zero, 7 dias, estoque 10. Confirmo produto e CEP').catch(()=>null);
  await until(()=>flow(responding).status==='done');
  assert.equal(flow(responding).next_check_at,null);assert.equal(db.prepare('SELECT channel FROM supplier_response_winner WHERE request_id=?').get(responding).channel,'whatsapp');
  await stop();await pending.catch(()=>{});parseDelay=0;db.prepare('UPDATE whatsapp_updates SET retry_after=NULL WHERE request_id=?').run(responding);await start();
  await until(()=>db.prepare('SELECT status FROM whatsapp_updates WHERE request_id=?').get(responding)?.status==='processed');
  assert.equal(tgSends.length,telegramCount,'reply cancels Telegram even after parser interruption/restart');
  assert.match(waSends.at(-1).text,/80.00/,'text negotiates 20% below initial supplier price');
  const beforeDuplicate=waSends.length;await reply(responding,'response-1','Duplicado');assert.equal(waSends.length,beforeDuplicate);
  await reply(responding,'response-2','Consigo sim');assert.match(waSends.at(-1).text,/confirmada e registrada/);
  let request=(await json(`/requests/${responding}`)).body;assert.equal(request.quote_completion_state,'concluida');
  await reply(responding,'response-3','Confirmo');request=(await json(`/requests/${responding}`)).body;
  assert.equal(request.quote_completion_state,'concluida');assert.equal(request.quotes.find(q=>q.id===request.completed_quote_id).unit_cents,8000);
  assert.ok((await json(`/requests/${responding}/messages`)).body.some(m=>m.channel==='whatsapp'&&m.sender_type==='SUPPLIER'));
  const recoveryId=await create('Recuperação de aceitação');
  await reply(recoveryId,'recover-first','Preço 100, frete zero, taxas zero, 7 dias e estoque 10.');
  await reply(recoveryId,'recover-last','Mensagem que exige reprocessamento');
  db.prepare("UPDATE whatsapp_updates SET content='Consigo sim' WHERE request_id=? AND id=(SELECT id FROM whatsapp_updates WHERE request_id=? ORDER BY rowid DESC LIMIT 1)").run(recoveryId,recoveryId);
  const beforeRecovery=waSends.length;
  const recovered=await json(`/requests/${recoveryId}/whatsapp/reprocess`,{},{authorization:'Bearer internal-test','idempotency-key':'repair-acceptance'});
  assert.equal(recovered.status,200);assert.equal(recovered.body.request.quote_completion_state,'concluida');assert.equal(waSends.length,beforeRecovery+1);
  await json(`/requests/${recoveryId}/whatsapp/reprocess`,{},{authorization:'Bearer internal-test','idempotency-key':'repair-acceptance'});
  assert.equal(waSends.length,beforeRecovery+1,'recovery cannot send duplicate final confirmations');
  // Connected voice has no timeout; its transcript goes to WhatsApp when the call ends.
  const active=await create();
  assert.equal((await json(`/call-session/${active}/start`,{call_id:'active-call'})).body.ok,true);
  assert.equal(flow(active).next_check_at,null);await stop();await start();assert.equal(flow(active).status,'voice_active');
  const transcript=[{sender_type:'AI',content:'Qual o preço?'},{sender_type:'SUPPLIER',content:'Ainda estou consultando.'}];
  const end=await json(`/call-session/${active}/end`,{call_id:'active-call',status:'failed',allow_transcript_extraction:false,transcript});
  assert.equal(end.status,200);assert.equal(flow(active).status,'wa_waiting');assert.equal(tgSends.length,telegramCount);
  assert.ok(waSends.some(m=>m.text.includes('Transcrição da ligação')&&m.text.includes('Ainda estou consultando')));
  const beforeEndDuplicate=waSends.length;await json(`/call-session/${active}/end`,{call_id:'active-call',status:'failed',allow_transcript_extraction:false,transcript});assert.equal(waSends.length,beforeEndDuplicate);
  // A scoped Vapi callback cannot target a different request.
  const quoteId=await create('Notebook teste');const quoteSession=(await json(`/call-session/${quoteId}`)).body;
  const callback={message:{type:'end-of-call-report',endedReason:'customer-ended-call',call:{id:'complete-voice',metadata:{request_id:quoteId,supplier_id:'teste-whatsapp'},artifact:{messages:[]}}}};
  const wrong=await json('/webhook/voice',callback,{'x-call-session-token':session.voice_webhook_token});assert.equal(wrong.status,401);
  // An arbitrary client completion flag is insufficient; all confirmed quote fields are required.
  const fakeComplete=await json(`/call-session/${quoteId}/end`,{call_id:'complete-voice',status:'completed',quote_completed:true,allow_transcript_extraction:false});
  assert.equal(fakeComplete.body.quote_completed,false);
  const complete=await json(`/call-session/${quoteId}/end`,{call_id:'complete-voice',status:'completed',transcript,quote:{initial_price:'100',final_price:'80',shipping_fee:'0',fees:'0',lead_days:3,qty:10,product_confirmed:true,destination_confirmed:true,supplier_confirmed:true}});
  assert.equal(complete.body.quote_completed,true);
  const done=(await json(`/requests/${quoteId}`)).body;assert.equal(done.status,'concluida');assert.ok(done.completed_quote_id);
  const beforeTranscript=waSends.length;
  const newTranscript=[{sender_type:'SUPPLIER',content:'Confirmação final por voz, muito obrigado.'}];
  await json(`/call-session/${quoteId}/end`,{call_id:'complete-voice',status:'completed',transcript:newTranscript,allow_transcript_extraction:false});
  assert.ok(waSends.slice(beforeTranscript).some(m=>m.text.includes('Confirmação final por voz')),'terminal report sends transcript even when tool already completed the quote');
  const hist=(await json(`/history/${quoteId}`)).body;
  assert.ok(hist.quotes.some(q=>q.channel==='voice'&&q.eligible));assert.ok(hist.conversations.some(c=>c.channel==='voice'));
  const lostClient=await create('Chamada sem callback do navegador');
  const providerId='123e4567-e89b-42d3-a456-426614174000';
  providerCall={id:providerId,status:'ended',endedReason:'customer-ended-call',metadata:{request_id:lostClient,supplier_id:'teste-whatsapp'},artifact:{messages:[{role:'user',message:'Transcrição recuperada do provedor.'}]}};
  await json(`/call-session/${lostClient}/start`,{call_id:providerId});
  await until(()=>flow(lostClient).status==='wa_waiting');
  assert.ok(waSends.some(m=>m.text.includes('Transcrição recuperada do provedor.')),'polling Vapi recovers a missing terminal callback');
  // An invitation timer cannot shorten the new WhatsApp deadline after an early call failure.
  await stop();await start('2');const earlyFailure=await create('Teste prazo após falha');
  const tgBeforeEarly=tgSends.length;
  await json(`/call-session/${earlyFailure}/end`,{call_id:'early-failure',status:'failed',allow_transcript_extraction:false});
  assert.equal(flow(earlyFailure).status,'wa_waiting');
  await new Promise(resolve=>setTimeout(resolve,2500));
  assert.equal(flow(earlyFailure).status,'wa_waiting');assert.equal(tgSends.length,tgBeforeEarly,'stale voice timer must respect the fresh WhatsApp deadline');
  console.log('PASS WebRTC → 120s → WhatsApp → 60s → Telegram; connected voice, transcript, restart/deduplication, delayed reply cancellation, LID/ninth digit, text counteroffer/final confirmation, scoped callback auth and voice quote history.');
} catch(error){console.error(error);process.exitCode=1;}
finally {if(child?.exitCode===null)await stop().catch(()=>{});db?.close();await new Promise(r=>fake.close(r));rmSync(dir,{recursive:true,force:true});}
