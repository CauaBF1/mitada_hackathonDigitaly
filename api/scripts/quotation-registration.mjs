import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const dir = mkdtempSync(join(tmpdir(), 'nexo-quotation-registration-'));
const dbPath = join(dir, 'business.sqlite');
const token = 'quotation-registration-internal';
const chat = '612';
const sent = [];
let telegramId = 1500;
let child;
let logs = '';

async function listen(server) { await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); return server.address().port; }
async function freePort() { const server = createServer(); const port = await listen(server); await new Promise(resolve => server.close(resolve)); return port; }
const telegram = createServer(async (req, res) => {
  let raw = ''; for await (const chunk of req) raw += chunk;
  const payload = JSON.parse(raw); sent.push(payload.text);
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true, result: { message_id: ++telegramId } }));
});
const agent = createServer(async (req, res) => {
  let raw = ''; for await (const chunk of req) raw += chunk;
  if (req.url === '/conversation-turn') {
    const input = JSON.parse(raw);
    let terms;
    if (/estoque/i.test(input.message)) terms = { available_qty: 10, payment_terms: 'PIX, cartão em 12x sem juros ou boleto' };
    else if (/validade/i.test(input.message)) terms = { valid_until: 'amanhã' };
    else terms = { supplier: null, unit_cents: 980, shipping_cents: 0, lead_days: 5, product_confirmed: true, destination_confirmed: true };
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
      intent: 'quotation', reply: 'Anotei os dados.', terms,
      explicit_confirmation: false, terms_changed: true, purchase_acceptance: 'unclear',
    }));
  } else if (req.url === '/tasks') res.writeHead(202).end('{"accepted":true}');
  else res.writeHead(404).end('{}');
});
await listen(telegram); await listen(agent);
const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const env = { ...process.env, PORT: String(port), DATABASE_PATH: dbPath, INTERNAL_API_TOKEN: token,
  AGENT_URL: `http://127.0.0.1:${agent.address().port}`, TELEGRAM_API_URL: `http://127.0.0.1:${telegram.address().port}`,
  TELEGRAM_BOT_TOKEN: 'mock-only', TELEGRAM_ALLOWED_CHAT_IDS: chat, TELEGRAM_WEBHOOK_SECRET: 'quotation-webhook-secret' };
function startApi() {
  const proc = spawn(process.execPath, ['dist/main.js'], { cwd: new URL('..', import.meta.url).pathname, env, stdio: ['ignore', 'pipe', 'pipe'] });
  proc.stdout.on('data', chunk => logs += chunk); proc.stderr.on('data', chunk => logs += chunk); return proc;
}
async function waitReady() {
  for (let i = 0; i < 120; i++) { if (child.exitCode !== null) throw new Error(`API exited: ${logs}`); try { if ((await fetch(`${base}/health`)).ok) return; } catch {} await new Promise(resolve => setTimeout(resolve, 50)); }
  throw new Error(`API did not start: ${logs}`);
}
async function stopApi() { if (!child || child.exitCode !== null) return; const proc = child; await new Promise(resolve => { proc.once('exit', resolve); proc.kill('SIGTERM'); }); }
async function json(path, method = 'GET', body, headers = {}) {
  const response = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}
async function supplierReply(id, updateId, message, parentId) {
  return json('/webhook/telegram', 'POST', { update_id: updateId, message: { text: message, chat: { id: Number(chat) },
    from: { id: Number(chat), first_name: 'Monitor612e0d7a' }, reply_to_message: { message_id: parentId } } },
  { 'x-telegram-bot-api-secret-token': 'quotation-webhook-secret' });
}
const db = new Database(dbPath);
try {
  child = startApi(); await waitReady();
  const created = await json('/requests', 'POST', { product: 'Item para cotação', specs: {}, qty: 1, destination: '01001-000' });
  assert.equal(created.status, 201);
  const id = created.body.id;
  const contacted = await json(`/requests/${id}/contact-supplier`, 'POST', {}, { 'idempotency-key': 'registration-open' });
  assert.equal(contacted.status, 201);
  const parentId = db.prepare('SELECT message_id FROM telegram_outbound WHERE request_id=? AND chat_id=? ORDER BY message_id DESC LIMIT 1').get(id, chat)?.message_id;
  assert.ok(parentId, 'opening Telegram message is mapped to the request');

  await supplierReply(id, 2001, 'R$ 9,80, frete grátis, prazo de 5 dias', parentId);
  await supplierReply(id, 2002, 'Estoque 10; PIX, cartão em 12x sem juros ou boleto', parentId);
  await supplierReply(id, 2003, 'Validade até amanhã', parentId);

  const request = (await json(`/requests/${id}`)).body;
  assert.notEqual(request.status, 'concluida', 'unknown fees must prevent quote completion');
  assert.notEqual(request.quote_completion_state, 'concluida');
  assert.equal(request.quote_completion_state, 'coletando');
  const draft = db.prepare('SELECT terms,missing_fields FROM conversation_drafts WHERE request_id=? AND chat_id=?').get(id, chat);
  const terms = JSON.parse(draft.terms);
  assert.equal(terms.supplier, 'Contato Monitor612e0d7a', 'validated Telegram first name supplies missing supplier name');
  assert.equal(terms.unit_cents, 980, 'later partial turns preserve earlier unit price');
  assert.equal(terms.shipping_cents, 0, 'later partial turns preserve explicitly free shipping');
  assert.equal(terms.lead_days, 5, 'later partial turns preserve delivery lead time');
  assert.equal(terms.available_qty, 10);
  assert.equal(terms.payment_terms, 'PIX, cartão em 12x sem juros ou boleto');
  assert.equal(terms.valid_until, 'amanhã');
  assert.ok(JSON.parse(draft.missing_fields).includes('fees_cents'), 'unknown fees remain missing');
  const quote = db.prepare('SELECT * FROM quotes WHERE request_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1').get(id);
  assert.equal(quote.unit_cents, 980);
  assert.equal(quote.shipping_cents, 0);
  assert.equal(quote.lead_days, 5);
  assert.equal(quote.available_qty, 10);
  assert.equal(quote.valid_until, 'amanhã');
  assert.equal(quote.payment_terms, 'PIX, cartão em 12x sem juros ou boleto');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM quotes WHERE request_id=?").get(id).n, 3, 'each distinct terms snapshot persists once');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM conversation_messages WHERE request_id=? AND sender_type='SUPPLIER'").get(id).n, 3);
  assert.ok(sent.length >= 4);
  assert.ok(sent.every(text => !/registrad[ao]|cotação confirmada|conversa encerrada/i.test(text)), 'no completion claim before all validated terms are persisted and confirmed');
  assert.match(sent.at(-1), /taxas adicionais/);
  console.log('PASS quotation registration: three partial turns preserve 980 cents, free shipping, five-day lead time, stock, validity and payment; supplier fallback; no completion claim with unknown fees.');
} finally {
  db.close(); await stopApi(); await new Promise(resolve => agent.close(resolve)); await new Promise(resolve => telegram.close(resolve)); rmSync(dir, { recursive: true, force: true });
}
