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
const sends = [], interpretations = [];
const voiceAttempts = [];
let callMode = 'reject', callEnded = false;
const fakeCallId = '00112233-4455-6677-8899-aabbccddeeff';
let sendMode = 'ok', parseMode = 'full', parseFailures = 0;
const full = { unit_cents: 5000, shipping_cents: 100, fees_cents: 0, lead_days: 2, available_qty: 5, product_confirmed: true, destination_confirmed: true, pending: [] };
const fake = createServer(async (req, res) => {
  let raw = ''; for await (const chunk of req) raw += chunk;
  const body = raw ? JSON.parse(raw) : {};
  res.setHeader('content-type', 'application/json');
  if (req.url === '/tasks') { res.writeHead(202).end('{"accepted":true}'); return; }
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
async function start(testSupplierNumber = '') {
  child = spawn(process.execPath, ['dist/main.js'], { stdio: ['ignore','pipe','pipe'], env: {
    ...process.env, PORT: String(port), DATABASE_PATH: dbPath, AGENT_URL: fakeUrl, INTERNAL_API_TOKEN: 'internal-test',
    WHATSAPP_API_URL: fakeUrl, WHATSAPP_API_KEY: 'evolution-test', WHATSAPP_INSTANCE_NAME: 'nexo', WHATSAPP_WEBHOOK_SECRET: 'wa-secret',
    VOICE_WEBHOOK_SECRET: 'voice-secret', TELEGRAM_BOT_TOKEN: '',
    WHATSAPP_TEST_SUPPLIER_NUMBER: testSupplierNumber,
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
async function until(predicate) { for (let i = 0; i < 130; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 100)); } throw new Error('Worker timeout'); }
try {
  await start(); db = new Database(dbPath);
  assert.equal((await json('/webhook/whatsapp', {})).status, 401);
  assert.equal((await json('/webhook/voice', {})).status, 401);
  const id = await create();
  assert.equal((await json(`/requests/${id}/whatsapp`, { supplier_id:'x',name:'x',number:'123' }, { authorization:'Bearer internal-test' })).status, 400);
  assert.equal((await json(`/requests/${id}/whatsapp`, {})).status, 401);
  assert.equal((await voice(id, 'call-1')).body.fallback.status, 'sent');
  assert.match(sends[0].text, /SSD \(Qtd: 2, Destino: 01001-000\)/);
  assert.match((await json(`/requests/${id}`)).body.notice, /Fallback efetuado/);
  const before = sends.length;
  await Promise.all([voice(id,'call-1'), voice(id,'call-1','hangup')]); assert.equal(sends.length, before);
  assert.equal((await voice(id,'success','completed',{quote_completed:true})).body.ignored,'quote-completed');
  assert.equal((await voice(id,'success','hangup')).body.ignored,'quote-completed');
  const unknown = await json('/requests', { product:'CPU',qty:1,destination:'01001-000',specs:{} });
  assert.equal((await voice(unknown.body.id,'no-number')).body.ignored,'no-whatsapp');
  for (const status of ['no-answer','failed','hangup']) assert.equal((await voice(id,`call-${status}`,status)).body.fallback.status,'sent');
  const vapi = await json('/webhook/voice',{ message:{type:'end-of-call-report', endedReason:'customer-did-not-answer', call:{id:'vapi-1', metadata:{request_id:id,supplier_id:'supplier-a'}}} },{'x-voice-webhook-secret':'voice-secret'});
  assert.equal(vapi.body.fallback.status,'sent');
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
  assert.match(sends.at(-1).text,/registrada/);
  parseMode='denied'; await wa(inbound('denied')); assert.equal((await json(`/requests/${id}`)).body.quotes[0].product_confirmed,false);
  // Separate suppliers must never share quote state or message history.
  await json(`/requests/${id}/whatsapp`,{supplier_id:'supplier-b',name:'B',number:'5511777777777'},{authorization:'Bearer internal-test'});
  await voice(id,'call-b','busy',{},'supplier-b'); parseMode='rest'; await wa(inbound('b-1','5511777777777'));
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
  // Network ambiguity never triggers automatic duplicate sends.
  sendMode='disconnect'; const uncertain=await voice(second,'uncertain'); assert.equal(uncertain.body.fallback.status,'uncertain');
  const count=sends.length; await voice(second,'uncertain'); assert.equal(sends.length,count);
  sendMode='reject'; assert.equal((await voice(second,'rejected')).body.fallback.status,'failed'); sendMode='ok';
  // Three consecutive interpreter failures exhaust the durable inbox.
  parseFailures=10; await wa(inbound('exhaust','5511999999999',parent));
  for(let i=0;i<2;i++) { db.prepare("UPDATE whatsapp_updates SET retry_after=NULL WHERE status='pending'").run(); const attempt=i+2; await until(()=>{ const state=db.prepare('SELECT attempts,status FROM whatsapp_updates ORDER BY rowid DESC LIMIT 1').get(); return state.attempts>=attempt && state.status!=='processing'; }); }
  await until(()=>db.prepare('SELECT status FROM whatsapp_updates ORDER BY rowid DESC LIMIT 1').get().status==='exhausted'); parseFailures=0;
  current=(await json(`/requests/${second}`)).body; const chosen=current.quotes.find(q=>q.eligible);
  await json(`/requests/${second}/decision`,{quote_id:chosen.id,version:current.version});
  assert.equal((await voice(second,'after-decision')).body.ignored,'decided');
  assert.equal((await wa(inbound('after-decision','5511999999999',parent))).body.ignored,'decided');
  // A configured test supplier is attached to every new request, without sending on creation.
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM whatsapp_contacts WHERE supplier_id='teste-whatsapp'").get().n,0);
  await stop(); await start('+5517991636725');
  const sendsBeforeDefault = sends.length;
  const defaults = [await create(), await create()];
  assert.equal(sends.length, sendsBeforeDefault);
  for (const requestId of defaults) {
    assert.equal(db.prepare("SELECT number FROM whatsapp_contacts WHERE request_id=? AND supplier_id='teste-whatsapp'").get(requestId).number,'5517991636725');
    assert.equal((await voice(requestId,`default-${requestId}`,'no-answer',{},'teste-whatsapp')).body.fallback.status,'sent');
    assert.equal(sends.at(-1).number,'5517991636725');
  }
  assert.equal((await wa(inbound('default-ambiguous','5517991636725'))).body.ignored,'ambiguous-request');
  console.log('PASS default test supplier: opt-in, every new request, normalized number, no implicit send, fallback recipient and ambiguous reply protection');
  const completeResearch = async requestId => {
    const task=db.prepare('SELECT id FROM tasks WHERE request_id=?').get(requestId);
    const result=await json(`/tasks/${task.id}/result`,{status:'completed',quotes:[],execution_version:1},{authorization:'Bearer internal-test'});
    assert.equal(result.status,200);
  };
  const automatic = await create(); const beforeAuto=sends.length;
  assert.equal(voiceAttempts.length,0,'must finish research before calling');
  await completeResearch(automatic);
  await until(()=>db.prepare('SELECT status FROM whatsapp_contact_flow WHERE request_id=?').get(automatic)?.status==='done');
  assert.equal(voiceAttempts.length,1); assert.equal(voiceAttempts[0].phone_number,'+5517991636725');
  assert.equal(sends.length,beforeAuto+1); assert.equal(sends.at(-1).number,'5517991636725');
  assert.match(db.prepare('SELECT error FROM whatsapp_contact_flow WHERE request_id=?').get(automatic).error,/HTTP 502/);
  await completeResearch(automatic); await stop(); await start('+5517991636725');
  assert.equal(voiceAttempts.length,1); assert.equal(sends.length,beforeAuto+1);
  callMode='accept'; const waiting=await create(); await completeResearch(waiting);
  await until(()=>db.prepare('SELECT status FROM whatsapp_contact_flow WHERE request_id=?').get(waiting)?.status==='waiting');
  assert.equal(voiceAttempts.length,2); const waitingSends=sends.length;
  await stop(); await start('+5517991636725');
  assert.equal(voiceAttempts.length,2,'restart must not redial'); assert.equal(sends.length,waitingSends,'do not send before call ends');
  callEnded=true; db.prepare('UPDATE whatsapp_contact_flow SET next_check_at=NULL WHERE request_id=?').run(waiting);
  await until(()=>db.prepare('SELECT status FROM whatsapp_contact_flow WHERE request_id=?').get(waiting)?.status==='done');
  assert.equal(sends.length,waitingSends+1); assert.equal(voiceAttempts.length,2);
  assert.equal((await fetch(`${base}/requests/${waiting}`,{method:'DELETE'})).status,200);
  assert.equal(db.prepare('SELECT 1 FROM whatsapp_contact_flow WHERE request_id=?').get(waiting),undefined);
  console.log('PASS automatic contact: research first, real voice request, rejected-call fallback, accepted-call polling, restart idempotency and deletion');
  console.log('PASS WhatsApp HTTP: auth, voice statuses/Vapi, dedupe, partial quotes/pending, pre-price state, supplier isolation, ambiguous replies, restart/retry/exhaustion, uncertain delivery, immutable decisions');
} catch(e) { console.error(e); console.error(logs); process.exitCode=1; }
finally { if(child?.exitCode===null) await stop(); db?.close(); await new Promise(resolve=>fake.close(resolve)); rmSync(dir,{recursive:true,force:true}); }
