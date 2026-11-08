import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
const Database = createRequire(import.meta.url)('better-sqlite3');
const dir = mkdtempSync(join(tmpdir(), 'nexo-whatsapp-'));
const dbPath = join(dir, 'business.sqlite');
const sends = [], interpretations = [], telegramSends = [];
const voiceAttempts = [];
let callMode = 'reject', callEnded = false;
const fakeCallId = '00112233-4455-6677-8899-aabbccddeeff';
let sendMode = 'ok', parseMode = 'full', parseFailures = 0, sendDelayMs = 0;
const full = { unit_cents: 5000, shipping_cents: 100, fees_cents: 0, lead_days: 2, available_qty: 5, product_confirmed: true, destination_confirmed: true, pending: [] };
const fake = createServer(async (req, res) => {
  let raw = ''; for await (const chunk of req) raw += chunk;
  const body = raw ? JSON.parse(raw) : {};
  res.setHeader('content-type', 'application/json');
  if (req.url === '/tasks') { res.writeHead(202).end('{"accepted":true}'); return; }
  if (req.url === '/bottest-telegram/sendMessage') { telegramSends.push(body); res.end(JSON.stringify({ ok:true, result:{ message_id:9000+telegramSends.length } })); return; }
  if (req.url === '/conversation-turn') { res.writeHead(404).end('{}'); return; }
  if (req.url === '/voice/call') {
    assert.equal(req.headers.authorization,'Bearer internal-test'); voiceAttempts.push(body);
    if (callMode==='reject') { res.writeHead(502).end('{"detail":"Provider rejected call"}'); return; }
    res.writeHead(201).end(JSON.stringify({call_id:fakeCallId,status:'queued',provider:'vapi'})); return;
  }
  if (req.url === `/voice/call/${fakeCallId}`) {
    assert.equal(req.headers.authorization,'Bearer internal-test');
    res.end(JSON.stringify({call_id:fakeCallId,status:callEnded?'ended':'ringing',ended_reason:'customer-did-not-answer',request_id:voiceAttempts.at(-1).request_id,supplier_id:'teste-whatsapp'})); return;
  }
  if (req.url === '/interpret-quote') {
    assert.equal(req.headers.authorization, 'Bearer internal-test'); interpretations.push(body);
    if (parseFailures-- > 0) { res.writeHead(503).end('{}'); return; }
    const quote = parseMode === 'partial' ? { unit_cents: 5000, product_confirmed: true, destination_confirmed: true, pending: ['frete','taxas','prazo','disponibilidade'] }
      : parseMode === 'rest' ? { shipping_cents: 100, fees_cents: 0, lead_days: 2, available_qty: 5, pending: ['preço unitário','confirmação do produto','confirmação do CEP'] }
      : parseMode === 'denied' ? { product_denied: true, pending: [] }
      : parseMode === 'before-price' ? { shipping_cents: 0, fees_cents: 0, product_confirmed: true, destination_confirmed: true, pending: ['preço unitário','prazo','disponibilidade'] }
      : parseMode === 'price-only' ? { unit_cents: 1000, lead_days: 1, available_qty: 10, pending: ['frete','taxas','confirmação do produto','confirmação do CEP'] } : full;
    res.end(JSON.stringify(quote)); return;
  }
  assert.equal(req.url, '/message/sendText/nexo'); assert.equal(req.headers.apikey, 'evolution-test');
  sends.push(body);
  if (sendDelayMs) await new Promise(resolve => setTimeout(resolve, sendDelayMs));
  if (sendMode === 'disconnect') { req.socket.destroy(); return; }
  if (sendMode === 'reject') { res.writeHead(400).end('{}'); return; }
  res.end(JSON.stringify({ key: { id: `out-${sends.length}` } }));
});
await new Promise(resolve => fake.listen(0, '127.0.0.1', resolve));
const fakeUrl = `http://127.0.0.1:${fake.address().port}`;
const portServer = createServer(); await new Promise(resolve => portServer.listen(0, '127.0.0.1', resolve));
const port = portServer.address().port; await new Promise(resolve => portServer.close(resolve));
const base = `http://127.0.0.1:${port}`;
let child, logs = '', db;
async function start(testSupplierNumber = '', telegramEnabled = false) {
  child = spawn(process.execPath, ['dist/main.js'], { stdio: ['ignore','pipe','pipe'], env: {
    ...process.env, PORT: String(port), DATABASE_PATH: dbPath, AGENT_URL: fakeUrl, INTERNAL_API_TOKEN: 'internal-test',
    WHATSAPP_API_URL: fakeUrl, WHATSAPP_API_KEY: 'evolution-test', WHATSAPP_INSTANCE_NAME: 'nexo', WHATSAPP_WEBHOOK_SECRET: 'wa-secret',
    VOICE_WEBHOOK_SECRET: 'voice-secret', TELEGRAM_BOT_TOKEN: telegramEnabled ? 'test-telegram' : '', TELEGRAM_API_URL: fakeUrl, TELEGRAM_ALLOWED_CHAT_IDS: '777', TELEGRAM_WEBHOOK_SECRET: 'test-telegram',
    WHATSAPP_TEST_SUPPLIER_NUMBER: testSupplierNumber, VAPI_PUBLIC_KEY:'', NEXT_PUBLIC_VAPI_PUBLIC_KEY:'', AUTO_CONFIGURE_INTEGRATIONS:'false',
  } });
  child.stdout.on('data', d => logs += d); child.stderr.on('data', d => logs += d);
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error(logs);
    try { if ((await fetch(`${base}/health`)).ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('API did not start');
}
async function stop() { const done = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGTERM'); await done; }
async function json(path, body, headers = {}) {
  const r = await fetch(`${base}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type':'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
}
async function create(number = '5511999999999', supplier = 'supplier-a') {
  const r = await json('/requests', { product: 'SSD', qty: 2, destination: '01001-000', specs: {} }); assert.equal(r.status, 201);
  const id = r.body.id;
  const c = await json(`/requests/${id}/whatsapp`, { supplier_id: supplier, name: supplier, number }, { authorization:'Bearer internal-test' }); assert.equal(c.status, 201);
  return id;
}
const voice = (request_id, call_id, status = 'busy', extra = {}, supplier_id = 'supplier-a') => json('/webhook/voice', { request_id, supplier_id, call_id, status, ...extra }, { 'x-voice-webhook-secret':'voice-secret' });
const inbound = (id, number = '5511999999999', parent, text = 'Cotação') => ({ event:'messages.upsert', instance:'nexo', data: { key:{ id, remoteJid:`${number}@s.whatsapp.net`, fromMe:false }, message: parent ? { extendedTextMessage:{ text, contextInfo:{ stanzaId:parent } } } : { conversation:text } } });
const wa = body => json('/webhook/whatsapp', body, { 'x-whatsapp-webhook-secret':'wa-secret' });
const telegram = (update_id, parent, text='Cotação pelo Telegram') => json('/webhook/telegram', {
  update_id, message:{message_id:10000+update_id,chat:{id:777},from:{id:777,first_name:'Fornecedor'},text,reply_to_message:{message_id:parent}},
}, {'x-telegram-bot-api-secret-token':'test-telegram'});
async function until(predicate) { for (let i = 0; i < 130; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 100)); } throw new Error('Worker timeout'); }
try {
  await start(); db = new Database(dbPath);
  assert.equal((await json('/webhook/whatsapp', {})).status, 401);
  assert.equal((await json('/webhook/voice', {})).status, 401);
  const id = await create();
  assert.equal((await json(`/requests/${id}/whatsapp`, { supplier_id:'x',name:'x',number:'123' }, { authorization:'Bearer internal-test' })).status, 400);
  assert.equal((await json(`/requests/${id}/whatsapp`, {})).status, 401);
  assert.equal((await voice(id, 'call-1')).body.status, 'whatsapp');
  assert.match(sends[0].text, /SSD \(2 unidades\).*01001-000/);
  assert.match((await json(`/requests/${id}`)).body.notice, /aguardando resposta/);
  const before = sends.length;
  await Promise.all([voice(id,'call-1'), voice(id,'call-1','hangup')]); assert.equal(sends.length, before);
  assert.equal((await voice(id,'success','completed',{quote_completed:true})).body.quote_completed,false,'unvalidated completion flag must not close the quote');
  assert.equal((await voice(id,'success','hangup')).body.status,'whatsapp');
  const unknown = await json('/requests', { product:'CPU',qty:1,destination:'01001-000',specs:{} });
  assert.equal((await voice(unknown.body.id,'no-number')).body.ignored,'no-whatsapp');
  for (const status of ['no-answer','failed','hangup']) assert.equal((await voice(id,`call-${status}`,status)).body.status,'whatsapp');
  const vapi = await json('/webhook/voice',{ message:{type:'end-of-call-report', endedReason:'customer-did-not-answer', call:{id:'vapi-1', metadata:{request_id:id,supplier_id:'supplier-a'}}} },{'x-voice-webhook-secret':'voice-secret'});
  assert.equal(vapi.body.status,'whatsapp');
  const loop = inbound('from-me'); loop.data.key.fromMe = true;
  assert.equal((await wa(loop)).body.ignored,'from-me');
  const group = inbound('group'); group.data.key.remoteJid='123@g.us'; assert.equal((await wa(group)).body.ignored,'unsupported-sender');
  group.data.key.remoteJidAlt='5511999999999@s.whatsapp.net'; assert.equal((await wa(group)).body.ignored,'unsupported-sender');
  const lid = inbound('lid-missing-phone'); lid.data.key.remoteJid='123456789@lid';
  assert.equal((await wa(lid)).body.ignored,'unsupported-sender');
  lid.data.key.remoteJidAlt='123456789@lid'; assert.equal((await wa(lid)).body.ignored,'unsupported-sender');
  assert.equal((await wa(inbound('stranger','5511888888888'))).body.ignored,'unknown-contact');
  const partial = inbound('partial'); partial.data.key.remoteJid='123456789@lid'; partial.data.key.remoteJidAlt='5511999999999@s.whatsapp.net';
  parseMode='partial'; assert.equal((await wa(partial)).body.status,'processed');
  let current = (await json(`/requests/${id}`)).body;
  assert.equal(current.status,'comparação'); assert.equal(current.quotes.length,1); assert.equal(current.quotes[0].eligible,false);
  assert.match(sends.at(-1).text,/frete, taxas, prazo, disponibilidade/); assert.doesNotMatch(sends.at(-1).text,/preço unitário/);
  const numSends=sends.length, numCalls=interpretations.length;
  await Promise.all([wa(inbound('partial')),wa(inbound('partial'))]); assert.equal(sends.length,numSends); assert.equal(interpretations.length,numCalls);
  parseMode='rest'; await wa(inbound('rest'));
  current=(await json(`/requests/${id}`)).body;
  assert.equal(current.quotes[0].eligible,true); assert.equal(current.quotes[0].unit_cents,5000); assert.equal(current.quotes[0].fees_cents,0);
  assert.match(sends.at(-1).text,/R\$ 40.00/,'complete terms start a counteroffer, not premature completion');
  parseMode='denied'; await wa(inbound('denied')); assert.equal((await json(`/requests/${id}`)).body.quotes[0].product_confirmed,false);
  // Separate suppliers must never share quote state or message history.
  const supplierB=await create('5511777777777','supplier-b');
  await voice(supplierB,'call-b','busy',{},'supplier-b'); parseMode='rest'; await wa(inbound('b-1','5511777777777'));
  assert.match(sends.at(-1).text,/preço unitário/); assert.doesNotMatch(interpretations.at(-1).text,/SUPPLIER: Cotação/);
  // Ambiguous open requests require a quoted outbound message.
  const second = await create(); await voice(second,'second-call');
  const parent=db.prepare('SELECT message_id FROM whatsapp_delivery WHERE request_id=?').get(second).message_id;
  assert.equal((await wa(inbound('ambiguous'))).body.ignored,'ambiguous-request');
  const quotedConversation = inbound('before-price');
  quotedConversation.data.contextInfo = { stanzaId: parent };
  quotedConversation.data.message = { conversation: 'Cotação' };
  parseMode='before-price'; assert.equal((await wa(quotedConversation)).body.status,'processed');
  assert.equal((await json(`/requests/${second}`)).body.quotes.length,0);
  parseMode='price-only'; await wa(inbound('price','5511999999999',parent));
  assert.equal((await json(`/requests/${second}`)).body.quotes[0].eligible,true);
  // Interpreter failure is durably retried, also after restart.
  parseMode='full'; parseFailures=1; await wa(inbound('retry','5511999999999',parent));
  assert.equal(db.prepare("SELECT status FROM whatsapp_updates WHERE content='Cotação' ORDER BY rowid DESC LIMIT 1").get().status,'pending');
  db.prepare("UPDATE whatsapp_updates SET status='processing',attempts=3,answer=NULL WHERE rowid=(SELECT MIN(rowid) FROM whatsapp_updates)").run();
  await stop(); db.prepare("UPDATE whatsapp_updates SET retry_after=NULL WHERE status='pending'").run(); await start();
  assert.equal(db.prepare('SELECT status FROM whatsapp_updates ORDER BY rowid LIMIT 1').get().status,'exhausted');
  await until(()=>db.prepare("SELECT status FROM whatsapp_updates ORDER BY rowid DESC LIMIT 1").get().status==='processed');
  assert.equal(db.prepare("SELECT attempts FROM whatsapp_updates ORDER BY rowid DESC LIMIT 1").get().attempts,2);
  const history=(await json(`/requests/${second}/messages`)).body;
  assert.ok(history.some(m=>m.sender_type==='AI')); assert.ok(history.some(m=>m.sender_type==='SUPPLIER'));
  assert.ok(history.every(m=>m.channel==='whatsapp'));
  assert.ok(history.some(m=>m.sender_type==='AI' && m.delivery_status==='sent'));
  assert.ok(history.some(m=>m.sender_type==='SUPPLIER' && m.delivery_status==='received'));
  // A late voice event must not interrupt a supplier who already replied by text.
  const count=sends.length;assert.equal((await voice(second,'late-voice')).body.ignored,'text-contact-already-active');assert.equal(sends.length,count);
  // Three consecutive interpreter failures exhaust the durable inbox.
  parseFailures=10; await wa(inbound('exhaust','5511999999999',parent));
  for(let i=0;i<2;i++) { db.prepare("UPDATE whatsapp_updates SET retry_after=NULL WHERE status='pending'").run(); const attempt=i+2; await until(()=>{ const state=db.prepare('SELECT attempts,status FROM whatsapp_updates ORDER BY rowid DESC LIMIT 1').get(); return state.attempts>=attempt && state.status!=='processing'; }); }
  await until(()=>db.prepare('SELECT status FROM whatsapp_updates ORDER BY rowid DESC LIMIT 1').get().status==='exhausted'); parseFailures=0;
  current=(await json(`/requests/${second}`)).body; const chosen=current.quotes.find(q=>q.eligible);
  await json(`/requests/${second}/decision`,{quote_id:chosen.id,version:current.version});
  assert.equal((await voice(second,'after-decision')).body.ignored,'decided');
  assert.equal((await wa(inbound('after-decision','5511999999999',parent))).body.ignored,'decided');
  // WhatsApp-first contact uses a durable 60-second deadline and preserves channel identity.
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM whatsapp_contacts WHERE supplier_id='teste-whatsapp'").get().n,0);
  await stop(); await start('+5517991636725', true);
  const sendCountBefore = sends.length;
  const first = await json('/requests', { product:'SSD',qty:2,destination:'01001-000',specs:{} });
  assert.equal(first.status,201);
  const firstId=first.body.id;
  await until(()=>db.prepare('SELECT status FROM whatsapp_contact_flow WHERE request_id=?').get(firstId)?.status==='wa_waiting');
  const firstFlow=db.prepare('SELECT * FROM whatsapp_contact_flow WHERE request_id=?').get(firstId);
  assert.equal(sends.length,sendCountBefore+1); assert.equal(voiceAttempts.length,0,'new contact flow must not initiate voice');
  const scheduledAt=Date.parse(firstFlow.next_check_at), sentAt=Date.parse(db.prepare('SELECT created_at FROM whatsapp_delivery WHERE request_id=?').get(firstId).created_at);
  assert.ok(scheduledAt-sentAt>=59000 && scheduledAt-sentAt<=65000);
  assert.equal((await json(`/requests/${firstId}`)).body.whatsapp_pending.length,0);
  const firstMsg=db.prepare('SELECT message_id FROM whatsapp_delivery WHERE request_id=?').get(firstId).message_id;
  assert.equal((await wa(inbound('recognized-reply','5517991636725',firstMsg,'Confirmo a cotação'))).body.status,'processed');
  assert.equal(db.prepare('SELECT status FROM whatsapp_contact_flow WHERE request_id=?').get(firstId).status,'done');
  await new Promise(resolve=>setTimeout(resolve,400)); assert.equal(telegramSends.length,0,'recognized WhatsApp reply cancels Telegram fallback');
  // A retry scheduled before the supplier response cannot leak a later Telegram message.
  const cancelledDelivery=`wa-fallback:${firstId}`;
  db.prepare("INSERT INTO telegram_delivery(id,request_id,chat_id,status,created_at,message_text,attempts) VALUES(?,?,?,'failed',?,?,0)").run(cancelledDelivery,firstId,'777',new Date().toISOString(),'Fallback antigo');
  await until(()=>db.prepare('SELECT status FROM telegram_delivery WHERE id=?').get(cancelledDelivery)?.status==='cancelled');
  assert.equal(telegramSends.length,0,'a failed fallback retry is cancelled when WhatsApp already won');
  // A correlated supplier reply can arrive while the opening send awaits its Evolution acknowledgement.
  await stop(); await start('+5522888888888', true); sendDelayMs=500;
  const delayedReply = await json('/requests', { product:'SSD',qty:2,destination:'01001-000',specs:{} });
  assert.equal(delayedReply.status,201); const delayedReplyId=delayedReply.body.id;
  await until(()=>db.prepare('SELECT status FROM whatsapp_delivery WHERE request_id=?').get(delayedReplyId)?.status==='sending');
  sendDelayMs=0;
  assert.equal((await wa(inbound('reply-before-ack','5522888888888',undefined,'Confirmo a cotação'))).body.status,'processed');
  await until(()=>db.prepare('SELECT status FROM whatsapp_contact_flow WHERE request_id=?').get(delayedReplyId)?.status==='done');
  await until(()=>db.prepare("SELECT status FROM whatsapp_delivery WHERE request_id=? AND content LIKE 'Olá! Você poderia cotar %'").get(delayedReplyId)?.status==='sent');
  assert.equal(telegramSends.length,0,'reply during an outstanding WhatsApp send suppresses fallback');
  sendDelayMs=500;
  const cancelledFlow = await json('/requests', { product:'SSD',qty:2,destination:'01001-000',specs:{} });
  assert.equal(cancelledFlow.status,201); const cancelledFlowId=cancelledFlow.body.id;
  await until(()=>db.prepare('SELECT status FROM whatsapp_delivery WHERE request_id=?').get(cancelledFlowId)?.status==='sending');
  // Apply the same durable state transition as cancelContact while the provider ACK is delayed.
  db.prepare("UPDATE whatsapp_contact_flow SET status='cancelled',next_check_at=NULL WHERE request_id=? AND status='ready'").run(cancelledFlowId);
  sendDelayMs=0; await until(()=>db.prepare('SELECT status FROM whatsapp_delivery WHERE request_id=?').get(cancelledFlowId)?.status==='sent');
  await new Promise(resolve=>setTimeout(resolve,500));
  assert.equal(db.prepare('SELECT status FROM whatsapp_contact_flow WHERE request_id=?').get(cancelledFlowId).status,'cancelled');
  assert.equal(telegramSends.length,0,'cancelled contact flow cannot be reopened after delayed ACK');
  const timedOutRequest = await json('/requests', { product:'SSD',qty:2,destination:'01001-000',specs:{} });
  assert.equal(timedOutRequest.status,201); const secondId=timedOutRequest.body.id;
  await until(()=>db.prepare('SELECT status FROM whatsapp_contact_flow WHERE request_id=?').get(secondId)?.status==='wa_waiting');
  const secondMessageCount=sends.length;
  // Move the persisted deadline into the past to model elapsed 60 seconds without sleeping.
  db.prepare('UPDATE whatsapp_contact_flow SET next_check_at=? WHERE request_id=?').run(new Date(Date.now()-1).toISOString(),secondId);
  await stop(); await start('+5517991636725', true);
  await until(()=>db.prepare('SELECT status FROM whatsapp_contact_flow WHERE request_id=?').get(secondId)?.status==='done');
  assert.equal(sends.length,secondMessageCount,'restart must not resend an accepted WhatsApp message');
  assert.equal(telegramSends.length,1); assert.equal(telegramSends[0].chat_id,'777');
  const secondNumber=db.prepare('SELECT number FROM whatsapp_contacts WHERE request_id=?').get(secondId).number;
  db.prepare("UPDATE requests SET status='concluida',quote_completion_state='concluida' WHERE id IN (SELECT request_id FROM whatsapp_contacts WHERE number=?) AND id<>?").run(secondNumber,secondId);
  const lateWa=await wa(inbound('late-wa-wins',secondNumber,undefined,'Resposta tardia no WhatsApp'));
  assert.equal(lateWa.body.status,'processed','WhatsApp can win after fallback and old completed requests do not make routing ambiguous');
  assert.equal(db.prepare('SELECT channel FROM supplier_response_winner WHERE request_id=?').get(secondId).channel,'whatsapp');
  const secondTelegramParent=db.prepare('SELECT message_id FROM telegram_outbound WHERE request_id=? ORDER BY rowid DESC LIMIT 1').get(secondId).message_id;
  const blockedTelegram=await telegram(81000,secondTelegramParent,'Telegram respondeu depois do WhatsApp');
  assert.equal(blockedTelegram.body.ignored,'other-channel-won',JSON.stringify(blockedTelegram.body));
  const telegramWin=await json('/requests',{product:'SSD',qty:2,destination:'01001-000',specs:{}});
  const telegramWinId=telegramWin.body.id;
  await until(()=>db.prepare("SELECT status FROM whatsapp_contact_flow WHERE request_id=?").get(telegramWinId)?.status==='wa_waiting');
  db.prepare('UPDATE whatsapp_contact_flow SET next_check_at=? WHERE request_id=?').run(new Date(Date.now()-1).toISOString(),telegramWinId);
  await stop(); await start('+5517991636725',true);
  await until(()=>telegramSends.length===2);
  const fallbackTelegramId=9000+telegramSends.length;
  const telegramAccepted=await telegram(81001,fallbackTelegramId,'Cotação pelo Telegram');
  assert.equal(telegramAccepted.status,200); assert.equal(telegramAccepted.body.ignored,undefined);
  assert.equal(db.prepare('SELECT channel FROM supplier_response_winner WHERE request_id=?').get(telegramWinId).channel,'telegram');
  const sameChannel=await telegram(81002,10000+81001,'Mais um detalhe pelo Telegram');
  assert.equal(sameChannel.status,200); assert.equal(sameChannel.body.ignored,undefined,'later replies from the winning channel remain accepted');
  const telegramWinWaParent=db.prepare('SELECT message_id FROM whatsapp_delivery WHERE request_id=? AND status=\'sent\' ORDER BY created_at DESC LIMIT 1').get(telegramWinId).message_id;
  const losingWa=await wa(inbound('telegram-winner-wa-loses','5517991636725',telegramWinWaParent,'Resposta concorrente WhatsApp'));
  assert.equal(losingWa.body.ignored,'other-channel-won');
  assert.equal(db.prepare('SELECT channel FROM supplier_response_winner WHERE request_id=?').get(telegramWinId).channel,'telegram');
  const secondHistory=(await json(`/requests/${secondId}/messages`)).body;
  assert.ok(secondHistory.some(m=>m.channel==='whatsapp'&&m.supplier_id==='whatsapp:teste-whatsapp'));
  assert.ok(secondHistory.some(m=>m.channel==='telegram'&&m.supplier_id==='telegram:777'));
  sendMode='disconnect';
  const uncertainRequest = await json('/requests', { product:'SSD',qty:2,destination:'01001-000',specs:{} });
  assert.equal(uncertainRequest.status,201); const uncertainId=uncertainRequest.body.id;
  const telegramSendsBeforeUncertain=telegramSends.length;
  await until(()=>db.prepare('SELECT status FROM whatsapp_contact_flow WHERE request_id=?').get(uncertainId)?.status==='wa_waiting');
  const uncertainSends=sends.length;
  assert.equal(db.prepare('SELECT status FROM whatsapp_delivery WHERE request_id=?').get(uncertainId).status,'uncertain');
  db.prepare('UPDATE whatsapp_contact_flow SET next_check_at=? WHERE request_id=?').run(new Date(Date.now()-1).toISOString(),uncertainId);
  await stop(); await start('+5517991636725', true);
  await until(()=>db.prepare('SELECT status FROM whatsapp_contact_flow WHERE request_id=?').get(uncertainId)?.status==='done');
  assert.equal(sends.length,uncertainSends,'uncertain WhatsApp delivery must never be resent after restart');
  assert.equal(telegramSends.length,telegramSendsBeforeUncertain+1,'fallback proceeds after the stored wait without assuming WhatsApp delivery');
  sendMode='ok';
  await stop(); await start('+5533888888888', true); sendDelayMs=500;
  const deleted = await json('/requests', { product:'SSD',qty:2,destination:'01001-000',specs:{} });
  const deletedId=deleted.body.id; await until(()=>db.prepare('SELECT status FROM whatsapp_delivery WHERE request_id=?').get(deletedId)?.status==='sending');
  const beforeDelete=telegramSends.length; assert.equal((await fetch(`${base}/requests/${deletedId}`,{method:'DELETE'})).status,200);
  sendDelayMs=0; await new Promise(resolve=>setTimeout(resolve,600));
  assert.equal(db.prepare('SELECT 1 FROM whatsapp_contact_flow WHERE request_id=?').get(deletedId),undefined);
  assert.equal(telegramSends.length,beforeDelete,'deleted requests cannot trigger fallback during delayed acknowledgement');
  console.log('PASS WhatsApp-first routing: exact persisted 60s deadline, reply cancellation including reply/cancel during delayed ACK, deletion during delayed ACK, no voice start, restart-safe no-resend for accepted/uncertain WA, authorized Telegram fallback, channel identity, deletion');
  console.log('PASS WhatsApp HTTP: auth, voice callbacks, dedupe, partial quotes/pending, pre-price state, supplier isolation, ambiguous replies, restart/retry/exhaustion, uncertain delivery, immutable decisions');
} catch(e) { console.error(e); console.error(logs); process.exitCode=1; }
finally { if(child?.exitCode===null) await stop(); db?.close(); await new Promise(resolve=>fake.close(resolve)); rmSync(dir,{recursive:true,force:true}); }
