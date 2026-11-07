import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const dir = mkdtempSync(join(tmpdir(), 'nexo-quote-completion-'));
const dbPath = join(dir, 'business.sqlite');
const token = 'quote-completion-token';
let sent = [];
let telegramId = 900;
let logs = '';
let child;

async function freePort() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

const telegram = createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const payload = JSON.parse(raw);
  sent.push(payload.text);
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true, result: { message_id: ++telegramId } }));
});
await new Promise(resolve => telegram.listen(0, '127.0.0.1', resolve));

const agent = createServer(async (req, res) => {
  let raw = ''; for await (const chunk of req) raw += chunk;
  if (req.url === '/conversation-turn') {
    const input=JSON.parse(raw), confirmation=/^(sim|confirmo)$/i.test(input.message.trim());
    const result=confirmation
      ? {intent:'quote_confirmation',reply:'Cotação confirmada.',terms:null,explicit_confirmation:true,terms_changed:false,purchase_acceptance:'unclear'}
      : {intent:'quotation',reply:'Obrigado! Anotei: Fornecedor Teste, preço unitário R$ 50.00, frete R$ 1.00, taxas R$ 0.00, prazo 2 dias e disponibilidade de 4 unidades. Confirma essas condições?',terms:{supplier:'Fornecedor Teste',unit_cents:5000,shipping_cents:100,fees_cents:0,lead_days:2,available_qty:4,product_confirmed:true,destination_confirmed:true,conditions:'Termos firmes.'},explicit_confirmation:false,terms_changed:true,purchase_acceptance:'unclear'};
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result));
  } else if(req.url==='/tasks') res.writeHead(202).end('{"accepted":true}');
  else res.writeHead(404).end('{}');
});
await new Promise(resolve => agent.listen(0, '127.0.0.1', resolve));

const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const env = { ...process.env, PORT: String(port), DATABASE_PATH: dbPath, INTERNAL_API_TOKEN: token,
  AGENT_URL: `http://127.0.0.1:${agent.address().port}`,
  TELEGRAM_API_URL: `http://127.0.0.1:${telegram.address().port}`, TELEGRAM_BOT_TOKEN: 'mock-only',
  TELEGRAM_ALLOWED_CHAT_IDS: '12345', TELEGRAM_WEBHOOK_SECRET: 'quote-webhook-secret' };

function startApi() {
  const proc = spawn(process.execPath, ['dist/main.js'], { cwd: new URL('..', import.meta.url).pathname, env, stdio: ['ignore', 'pipe', 'pipe'] });
  proc.stdout.on('data', chunk => logs += chunk);
  proc.stderr.on('data', chunk => logs += chunk);
  return proc;
}
async function waitReady(proc) {
  for (let i = 0; i < 100; i++) {
    if (proc.exitCode !== null) throw new Error(`API exited: ${logs}`);
    try { if ((await fetch(`${base}/health`)).ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`API did not start: ${logs}`);
}
async function stopApi() {
  if (!child || child.exitCode !== null) return;
  const proc = child;
  await new Promise(resolve => { proc.once('exit', resolve); proc.kill('SIGTERM'); });
}
async function json(path, method = 'GET', body, headers = {}) {
  const response = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}
async function supplierReply(requestId, updateId, text, parentId) {
  return json('/webhook/telegram', 'POST', { update_id: updateId, message: { text, chat: { id: 12345 },
    from: { id: 12345, first_name: 'Teste' }, reply_to_message: { message_id: parentId } } },
  { 'x-telegram-bot-api-secret-token': 'quote-webhook-secret' });
}
const db = new Database(dbPath);

try {
  child = startApi();
  await waitReady(child);
  async function createAndSummarize(name, updateId) {
    const created = await json('/requests', 'POST', { product: name, specs: {}, qty: 1, destination: '01001-000' });
    assert.equal(created.status, 201);
    const id = created.body.id;
    const parent = db.prepare('SELECT message_id FROM telegram_outbound WHERE request_id=? ORDER BY message_id DESC LIMIT 1').get(id).message_id;
    await supplierReply(id, updateId, 'Cotação completa, termos confirmados para validação.', parent);
    const request = (await json(`/requests/${id}`)).body;
    assert.equal(request.quote_completion_state, 'aguardando_confirmacao');
    const summary = db.prepare("SELECT telegram_message_id FROM conversation_messages WHERE request_id=? AND sender_type='AI' AND content LIKE '%Confirma essas condições?%' ORDER BY created_at DESC LIMIT 1").get(id);
    assert.ok(summary?.telegram_message_id, 'summary must be stored and reply-addressable');
    return { id, parent, summaryId: summary.telegram_message_id };
  }

  const normal = await createAndSummarize('Cotação confirmação', 1001);
  const beforeRestartSends = sent.length;
  await stopApi();
  child = startApi();
  await waitReady(child);
  assert.equal((await json(`/requests/${normal.id}`)).body.quote_completion_state, 'aguardando_confirmacao', 'state survives API restart');
  const yesUpdate = { update_id: 1002, message: { text: 'Sim', chat: { id: 12345 }, from: { id: 12345 }, reply_to_message: { message_id: normal.summaryId } } };
  const yes = await json('/webhook/telegram', 'POST', yesUpdate, { 'x-telegram-bot-api-secret-token': 'quote-webhook-secret' });
  assert.equal(yes.body.completed, true);
  let request = (await json(`/requests/${normal.id}`)).body;
  assert.equal(request.status, 'concluida');
  assert.equal(request.quote_completion_state, 'concluida');
  assert.equal(request.decision, null, 'quote confirmation is separate from buyer decision');
  assert.equal(sent.length, beforeRestartSends + 1, 'one final Telegram message');
  assert.match(sent.at(-1), /conversa encerrada/);
  assert.doesNotMatch(sent.at(-1), /Confirma essas condições\?/);
  assert.doesNotMatch(sent.at(-1), /pedido|pagamento/i);
  const afterFinalSends = sent.length;
  assert.deepEqual((await json('/webhook/telegram', 'POST', yesUpdate, { 'x-telegram-bot-api-secret-token': 'quote-webhook-secret' })).body, { ok: true, duplicate: true });
  assert.equal(sent.length, afterFinalSends, 'replayed confirmation update does not send again');
  await supplierReply(normal.id, 1003, 'Sim', normal.summaryId);
  assert.equal(sent.length, afterFinalSends + 1, 'a new post-closure supplier message receives a natural reply');
  assert.match(sent.at(-1), /Cotação confirmada\./);
  assert.doesNotMatch(sent.at(-1), /conversa encerrada|Confirma essas condições\?|pedido|pagamento/i,
    'post-closure reply is not another final, confirmation prompt, or purchase message');
  assert.equal(sent.filter(message => /conversa encerrada/i.test(message)).length, 1, 'closure final is sent exactly once');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM telegram_updates WHERE update_id=1003').get().n, 1, 'new supplier update is recorded once');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM conversation_messages WHERE request_id=? AND update_id=1003 AND sender_type=\'SUPPLIER\'').get(normal.id).n, 1,
    'new supplier message is stored once');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM telegram_delivery WHERE source_update_id=1003').get().n, 1, 'natural reply has one delivery record');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM purchase_simulations WHERE request_id=?').get(normal.id).n, 0, 'post-closure reply creates no purchase simulation');

  const changed = await createAndSummarize('Cotação termos alterados', 1101);
  db.prepare("INSERT INTO quotes(id,request_id,event_id,supplier,unit_cents,shipping_cents,fees_cents,lead_days,available_qty,conditions,product_confirmed,destination_confirmed,created_at) SELECT lower(hex(randomblob(16))),request_id,'telegram:1102',supplier,unit_cents+100,shipping_cents,fees_cents,lead_days,available_qty,conditions,product_confirmed,destination_confirmed,'9999-01-01T00:00:00.000Z' FROM quotes WHERE request_id=? ORDER BY created_at DESC LIMIT 1").run(changed.id);
  const beforeChangedYes = sent.length;
  await supplierReply(changed.id, 1102, 'Sim', changed.summaryId);
  request = (await json(`/requests/${changed.id}`)).body;
  assert.notEqual(request.status, 'concluida', 'yes against changed terms must not complete old snapshot');
  assert.equal(request.quote_completion_state, 'aguardando_confirmacao', 'new complete terms require a fresh summary');
  assert.equal(sent.length, beforeChangedYes + 1);
  assert.match(sent.at(-1), /Confirma essas condições\?/);

  const partial = await createAndSummarize('Cotação parcial', 1201);
  const partialQuote = (await json(`/requests/${partial.id}`)).body.quotes[0];
  const partialUpdate = await json(`/requests/${partial.id}/quotes`, 'POST', { event_id: 'quote-partial-followup', supplier: partialQuote.supplier,
    unit_cents: partialQuote.unit_cents, shipping_cents: null, fees_cents: partialQuote.fees_cents, lead_days: partialQuote.lead_days,
    available_qty: partialQuote.available_qty, product_confirmed: true, destination_confirmed: true, conditions: 'Frete pendente.' });
  assert.equal(partialUpdate.status, 201);
  assert.equal(partialUpdate.body.quote_completion_state, 'coletando', 'incomplete terms invalidate the old snapshot');
  assert.equal(partialUpdate.body.quote_terms_snapshot, null);
  const unauthenticatedReconcile = await json(`/requests/${partial.id}/reconcile-confirmation`, 'POST', {});
  assert.equal(unauthenticatedReconcile.status, 401);
  const reconcile = await json(`/requests/${partial.id}/reconcile-confirmation`, 'POST', {}, { authorization: `Bearer ${token}` });
  assert.equal(reconcile.status, 200);
  assert.equal(reconcile.body.reconciled, false);
  assert.notEqual((await json(`/requests/${partial.id}`)).body.status, 'concluida', 'complete values alone do not reconcile without historical confirmation');

  const legacy = await createAndSummarize('Cotação recuperação do histórico', 1301);
  const summaryText = db.prepare("SELECT content FROM conversation_messages WHERE request_id=? AND sender_type='AI' AND content LIKE '%Confirma essas condições?%' ORDER BY created_at DESC LIMIT 1").get(legacy.id).content;
  db.prepare('DELETE FROM conversation_messages WHERE request_id=?').run(legacy.id);
  const history = [
    ['AI', summaryText], ['SUPPLIER', 'Sim'], ['AI', summaryText], ['SUPPLIER', 'Confirmo'], ['AI', summaryText],
  ];
  history.forEach(([sender, content], index) => db.prepare('INSERT INTO conversation_messages(id,request_id,chat_id,sender_type,content,delivery_status,created_at) VALUES(?,?,?, ?,?,\'sent\',?)')
    .run(`legacy-${index}-${legacy.id}`, legacy.id, '12345', sender, content, `2026-11-07T14:00:0${index}.000Z`));
  const beforeReconcile = sent.length;
  const reconciled = await json(`/requests/${legacy.id}/reconcile-confirmation`, 'POST', {}, { authorization: `Bearer ${token}` });
  assert.equal(reconciled.status, 200);
  assert.equal(reconciled.body.completed, true);
  assert.equal((await json(`/requests/${legacy.id}`)).body.status, 'concluida');
  assert.equal(sent.length, beforeReconcile + 1, 'historical confirmation sends exactly one final');
  assert.doesNotMatch(sent.at(-1), /Confirma essas condições\?/);
  const afterReconcileFinal = sent.length;
  const reconcileDuplicate = await json(`/requests/${legacy.id}/reconcile-confirmation`, 'POST', {}, { authorization: `Bearer ${token}` });
  assert.equal(reconcileDuplicate.body.duplicate, true);
  assert.equal(sent.length, afterReconcileFinal, 'reconciliation is idempotent');
  console.log('PASS quote completion: summary -> explicit yes -> single final, duplicate suppression, changed terms, restart persistence, and repeated-summary historical reconciliation');
} finally {
  db.close();
  await stopApi();
  await new Promise(resolve => agent.close(resolve));
  await new Promise(resolve => telegram.close(resolve));
  rmSync(dir, { recursive: true, force: true });
}
