import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

const dir = mkdtempSync(join(tmpdir(), 'nexo-api-smoke-'));
const token = 'smoke-internal-token';
async function freePort() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
let dispatched;
let telegramMessageId = 500;
let telegramSends = 0;
let interpretCalls = 0;
const fakeAgent = createServer(async (req, res) => {
  let body = '';
  for await (const chunk of req) body += chunk;
  if (req.url === '/interpret-quote') {
    if (++interpretCalls === 1) { res.writeHead(503).end('{"error":"temporary mock failure"}'); return; }
    const payload = JSON.parse(body);
    const currentText = payload.text.split('Mensagem atual do fornecedor:').at(-1);
    const partial = currentText.includes('smoke-incremental');
    const denial = currentText.includes('smoke-denial');
    const quote = partial ? (payload.text.includes('somente-frete') ? {supplier:null,unit_cents:null,shipping_cents:250,fees_cents:null,lead_days:3,available_qty:null,product_confirmed:false,destination_confirmed:false,conditions:''} : {supplier:null,unit_cents:5000,shipping_cents:null,fees_cents:null,lead_days:null,available_qty:null,product_confirmed:true,destination_confirmed:true,conditions:''}) : denial ? {supplier:null,unit_cents:null,shipping_cents:null,fees_cents:null,lead_days:null,available_qty:null,product_confirmed:false,destination_confirmed:false,product_denied:true,conditions:''} : { supplier: 'Telegram Mock', unit_cents: 5000, shipping_cents: 100, fees_cents: 0, lead_days: 2, available_qty: 5, product_confirmed: true, destination_confirmed: true, conditions: 'Produto e destino confirmados.' };
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(quote));
  } else {
    dispatched = JSON.parse(body);
    res.writeHead(202, { 'content-type': 'application/json' }).end('{"accepted":true}');
  }
});
await new Promise(resolve => fakeAgent.listen(0, '127.0.0.1', resolve));
const agentPort = fakeAgent.address().port;
const apiPort = await freePort();
const fakeTelegram = createServer(async (req, res) => {
  for await (const _ of req) {}
  telegramSends++;
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, result: { message_id: ++telegramMessageId } }));
});
await new Promise(resolve => fakeTelegram.listen(0, '127.0.0.1', resolve));
const child = spawn(process.execPath, ['dist/main.js'], {
  cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, PORT: String(apiPort), DATABASE_PATH: join(dir, 'business.sqlite'), INTERNAL_API_TOKEN: token,
    AGENT_URL: `http://127.0.0.1:${agentPort}`, TELEGRAM_API_URL: `http://127.0.0.1:${fakeTelegram.address().port}`, TELEGRAM_BOT_TOKEN: 'smoke-token', TELEGRAM_ALLOWED_CHAT_IDS: '12345', TELEGRAM_WEBHOOK_SECRET: 'smoke-webhook-secret' },
});
let logs = '';
let gateway;
let gatewayLogs = '';
child.stdout.on('data', chunk => logs += chunk);
child.stderr.on('data', chunk => logs += chunk);
const base = `http://127.0.0.1:${apiPort}`;
async function waitReady() {
  for (let i = 0; i < 80; i++) {
    if (child.exitCode !== null) throw new Error(`Nest exited early: ${logs}`);
    try { if ((await fetch(`${base}/health`)).ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Nest did not start: ${logs}`);
}
async function json(path, method = 'GET', body, headers = {}) {
  const response = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}
try {
  await waitReady();
  const gatewayPort = await freePort();
  gateway = spawn(process.env.PYTHON_BIN || 'python3', ['../scripts/telegram_webhook_gateway.py'], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GATEWAY_HOST: '127.0.0.1', GATEWAY_PORT: String(gatewayPort), NEST_API_URL: base, TELEGRAM_WEBHOOK_SECRET: 'smoke-webhook-secret' } });
  gateway.stdout.on('data', chunk => gatewayLogs += chunk);
  gateway.stderr.on('data', chunk => gatewayLogs += chunk);
  const gatewayBase = `http://127.0.0.1:${gatewayPort}`;
  let gatewayReady = false;
  for (let i = 0; i < 50; i++) { try { const r = await fetch(`${gatewayBase}/health`); if (r.status === 404) { gatewayReady = true; break; } } catch {} await new Promise(resolve => setTimeout(resolve, 100)); }
  assert.equal(gatewayReady, true, `gateway did not start (exit=${gateway.exitCode}): ${gatewayLogs}`);
  assert.equal((await fetch(`${gatewayBase}/webhook/telegram`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 401);
  const forwarded = await fetch(`${gatewayBase}/webhook/telegram`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': 'smoke-webhook-secret' }, body: '{"update_id":2}' });
  assert.deepEqual(await forwarded.json(), { ok: true, ignored: 'unsupported' });
  assert.equal((await fetch(`${gatewayBase}/health`)).status, 404);
  assert.equal((await json('/webhook/telegram', 'POST', { update_id: 1 })).status, 401);
  const webhook = await json('/webhook/telegram', 'POST', { update_id: 1 }, { 'x-telegram-bot-api-secret-token': 'smoke-webhook-secret' });
  assert.deepEqual(webhook.body, { ok: true, ignored: 'unsupported' });
  const helpBody = { update_id: 101, message: { text: '/test', chat: { id: 12345 }, from: { id: 12345 } } };
  assert.deepEqual((await json('/webhook/telegram', 'POST', helpBody, { 'x-telegram-bot-api-secret-token': 'smoke-webhook-secret' })).body, { ok: true, command: '/test' });
  const sendsAfterCommand = telegramSends;
  assert.deepEqual((await json('/webhook/telegram', 'POST', helpBody, { 'x-telegram-bot-api-secret-token': 'smoke-webhook-secret' })).body, { ok: true, duplicate: true });
  assert.equal(telegramSends, sendsAfterCommand);
  const retryRequest = await json('/requests', 'POST', { product: 'Item para retry', specs: {}, qty: 1, destination: '01001-000' });
  const db = new Database(join(dir, 'business.sqlite'));
  const replyMessage = db.prepare('SELECT message_id FROM telegram_outbound WHERE request_id=? ORDER BY message_id DESC LIMIT 1').get(retryRequest.body.id).message_id;
  const pendingUpdate = { update_id: 102, message: { text: 'Fornecedor Mock: R$ 50,00 mais frete R$ 1,00; prazo 2 dias; estoque 5; produto e destino confirmados', chat: { id: 12345 }, from: { id: 12345 }, reply_to_message: { message_id: replyMessage } } };
  const firstInterpret = await json('/webhook/telegram', 'POST', pendingUpdate, { 'x-telegram-bot-api-secret-token': 'smoke-webhook-secret' });
  assert.equal(firstInterpret.body.pending, true);
  const inbox = db.prepare('SELECT status,attempts,raw_update FROM telegram_updates WHERE update_id=102').get();
  assert.equal(inbox.status, 'pending');
  assert.match(inbox.raw_update, /Fornecedor Mock/);
  db.prepare('UPDATE telegram_updates SET retry_after=? WHERE update_id=102').run(new Date(0).toISOString());
  for (let i = 0; i < 80 && db.prepare('SELECT status FROM telegram_updates WHERE update_id=102').get().status !== 'processed'; i++) await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(db.prepare('SELECT status FROM telegram_updates WHERE update_id=102').get().status, 'processed');
  assert.equal(db.prepare('SELECT attempts FROM telegram_updates WHERE update_id=102').get().attempts, 2);
  const incremental = await json('/requests', 'POST', { product: 'Item incremental', specs: {}, qty: 1, destination: '13565-090' });
  const incrementalReply = db.prepare('SELECT message_id FROM telegram_outbound WHERE request_id=? ORDER BY message_id DESC LIMIT 1').get(incremental.body.id).message_id;
  const supplierTurn = async (update_id, text) => json('/webhook/telegram', 'POST', { update_id, message: { text, chat: { id: 12345 }, from: { id: 12345, first_name: 'Ana' }, reply_to_message: { message_id: incrementalReply } } }, { 'x-telegram-bot-api-secret-token': 'smoke-webhook-secret' });
  await supplierTurn(201, 'smoke-incremental preço unitário');
  let partialQuote = db.prepare("SELECT unit_cents,shipping_cents,product_confirmed FROM quotes WHERE request_id=? AND event_id='telegram:201'").get(incremental.body.id);
  assert.equal(partialQuote.unit_cents, 5000);
  assert.equal(partialQuote.shipping_cents, null);
  await supplierTurn(202, 'smoke-incremental somente-frete');
  partialQuote = db.prepare("SELECT unit_cents,shipping_cents,lead_days FROM quotes WHERE request_id=? AND event_id='telegram:202'").get(incremental.body.id);
  assert.deepEqual(partialQuote, { unit_cents: 5000, shipping_cents: 250, lead_days: 3 });
  await supplierTurn(203, 'smoke-denial produto não atende');
  assert.equal(db.prepare("SELECT product_confirmed FROM quotes WHERE request_id=? AND event_id='telegram:203'").get(incremental.body.id).product_confirmed, 0);
  const history = await json(`/requests/${incremental.body.id}/messages`);
  assert.equal(history.status, 200);
  assert.deepEqual(new Set(history.body.map(m => m.sender_type)), new Set(['AI', 'SUPPLIER']));
  assert.ok(history.body.every(m => m.id && m.created_at && m.content));
  const beforeContact = telegramSends;
  const contact = await json(`/requests/${incremental.body.id}/contact-supplier`, 'POST', {}, { 'Idempotency-Key': 'smoke-contact-1' });
  assert.equal(contact.body.status, 'sent');
  assert.equal(telegramSends, beforeContact + 1);
  await json(`/requests/${incremental.body.id}/contact-supplier`, 'POST', {}, { 'Idempotency-Key': 'smoke-contact-1' });
  assert.equal(telegramSends, beforeContact + 1);
  db.close();
  let created = await json('/requests', 'POST', { product: 'SSD empresarial', specs: {}, qty: 1, destination: '01001-000' });
  assert.equal(created.status, 201);
  const first = created.body, task = dispatched;
  assert.equal(task.execution_version, 1);
  assert.equal((await json(`/tasks/${task.task_id}/result`, 'POST', { status: 'completed', execution_version: 1, quotes: [] })).status, 401);
  const quote = { event_id: 'smoke:offer-1', supplier: 'Loja Exemplo', unit_cents: 1999, shipping_cents: 100, fees_cents: 50, lead_days: 3, available_qty: 4, product_confirmed: true, destination_confirmed: true, source_url: 'https://store.example/ssd', conditions: 'Produto e CEP confirmados.' };
  let callback = await json(`/tasks/${task.task_id}/result`, 'POST', { status: 'completed', execution_version: 1, quotes: [quote], agent_notes: { market_discovery: 'Análise executada.' } }, { authorization: `Bearer ${token}` });
  assert.equal(callback.status, 200);
  let current = (await json(`/requests/${first.id}`)).body;
  assert.equal(current.quotes.length, 1);
  assert.equal(current.quotes[0].unit_cents, 1999);
  assert.equal(current.quotes[0].tco, 21.49);
  assert.equal(current.quotes[0].eligible, true);
  assert.equal(current.quotes[0].source_url, quote.source_url);
  assert.equal(current.agent_analysis.market_discovery, 'Análise executada.');
  assert.equal((await json(`/tasks/${task.task_id}/result`, 'POST', { status: 'completed', execution_version: 1, quotes: [quote] }, { authorization: `Bearer ${token}` })).body.duplicate, true);
  assert.equal((await json(`/requests/${first.id}/quotes`, 'POST', { ...quote, unit_cents: 1999.5 })).status, 400);
  const stale = await json(`/requests/${first.id}/decision`, 'POST', { quote_id: current.quotes[0].id, version: current.version - 1 });
  assert.equal(stale.status, 400);
  const decided = await json(`/requests/${first.id}/decision`, 'POST', { quote_id: current.quotes[0].id, version: current.version });
  assert.equal(decided.status, 201);
  assert.equal(decided.body.status, 'decidida');
  assert.equal((await json(`/requests/${first.id}/quotes`, 'POST', { ...quote, event_id: 'after-decision', unit_cents: 2000 })).status, 400);
  assert.deepEqual((await json(`/tasks/${task.task_id}/result`, 'POST', { status: 'completed', execution_version: 1, quotes: [quote] }, { authorization: `Bearer ${token}` })).body, { ok: true, ignored: 'decided' });

  created = await json('/requests', 'POST', { product: 'Notebook', specs: {}, qty: 2, destination: '20000-000' });
  const pendingReq = created.body, pendingTask = dispatched;
  const incomplete = { event_id: 'smoke:pending', supplier: 'Loja Pendente', unit_cents: 99000, shipping_cents: null, fees_cents: 0, lead_days: 4, available_qty: 2, product_confirmed: true, destination_confirmed: true };
  await json(`/tasks/${pendingTask.task_id}/result`, 'POST', { status: 'completed', execution_version: 1, quotes: [incomplete] }, { authorization: `Bearer ${token}` });
  current = (await json(`/requests/${pendingReq.id}`)).body;
  assert.equal(current.quotes[0].eligible, false);
  assert.match((await json(`/requests/${pendingReq.id}/decision`, 'POST', { quote_id: current.quotes[0].id, version: current.version })).body.message, /TCO seguro/);
  console.log('PASS smoke HTTP: webhook auth + restricted gateway forwarding, durable pending inbox + bounded worker retry, command dedupe, callback auth/idempotency, cents/TCO and immutable decisions');
} catch (error) {
  console.error(error);
  console.error(logs);
  process.exitCode = 1;
} finally {
  child.kill('SIGTERM');
  gateway?.kill('SIGTERM');
  await new Promise(resolve => child.once('exit', resolve));
  await new Promise(resolve => fakeAgent.close(resolve));
  await new Promise(resolve => fakeTelegram.close(resolve));
  rmSync(dir, { recursive: true, force: true });
}
