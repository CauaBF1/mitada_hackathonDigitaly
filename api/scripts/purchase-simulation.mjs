import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';

// Isolated contract test: all API, agent, supplier and Telegram traffic stays on loopback.
const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const dir = mkdtempSync(join(tmpdir(), 'nexo-purchase-'));
const dbPath = join(dir, 'business.sqlite');
const token = 'purchase-simulation-internal-test-token';
const webhookSecret = 'purchase-simulation-webhook-test-secret';
const supplierChat = '12345';
let mode = 'terms';
let stage = 'startup';
let telegramMessageId = 4000;
let telegramSends = [];
const agentPhaseObservations = [];
const expectedAgentPhase = new Map([
  ['early-acceptance-before-buyer-approval', 'quote_completed'],
  ['accept-simulated-order', 'purchase'],
  ['reprice-via-old-order', 'purchase'],
  ['stale-old-order-after-reprice', 'quote_confirmation'],
  ['stale-old-order-after-reapproval', 'purchase'],
]);
let child;
let logs = '';

async function listen(server) {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return server.address().port;
}
async function close(server) { if (server?.listening) await new Promise(resolve => server.close(resolve)); }
async function freePort() { const server = createServer(); const port = await listen(server); await close(server); return port; }

const telegram = createServer(async (req, res) => {
  let raw = ''; for await (const chunk of req) raw += chunk;
  assert.equal(req.method, 'POST');
  assert.match(req.url, /^\/botmock-token\/sendMessage$/);
  const messageId = ++telegramMessageId;
  telegramSends.push({ payload: JSON.parse(raw), messageId });
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true, result: { message_id: messageId } }));
});
const telegramPort = await listen(telegram);

const agent = createServer(async (req, res) => {
  let raw = ''; for await (const chunk of req) raw += chunk;
  res.setHeader('content-type', 'application/json');
  if (req.url === '/tasks' && req.method === 'POST') {
    const task = JSON.parse(raw);
    assert.ok(task.product || task.item || task.request_id, `unexpected task shape: ${raw}`);
    res.writeHead(202); return res.end(JSON.stringify({ accepted: true }));
  }
  if (req.url === '/conversation-turn' && req.method === 'POST') {
    const input = JSON.parse(raw);
    agentPhaseObservations.push({ stage, endpoint: req.url, mode, phase: input.phase, message: input.message });
    const terms = { supplier: 'Fornecedor Simulado', unit_cents: 1250, shipping_cents: 200, fees_cents: 50,
      lead_days: 3, available_qty: 20, conditions: 'termos locais', product_confirmed: true, destination_confirmed: true };
    const result = mode === 'terms'
      ? { intent: 'quotation', reply: 'Confirma as condições?', terms, explicit_confirmation: false, terms_changed: true, purchase_acceptance: 'unclear' }
      : mode === 'quote-confirm'
        ? { intent: 'quote_confirmation', reply: 'Cotação confirmada.', terms: null, explicit_confirmation: true, terms_changed: false, purchase_acceptance: 'unclear' }
        : mode === 'accept'
          ? { intent: 'purchase', reply: 'Pedido simulado aceito.', terms: null, explicit_confirmation: false, terms_changed: false, purchase_acceptance: 'accepted' }
          : mode === 'reprice-accept'
            ? { intent: 'quotation', reply: 'Termos atualizados.', terms: { ...terms, unit_cents: 1300 }, explicit_confirmation: false, terms_changed: true, purchase_acceptance: 'accepted' }
            : { intent: 'purchase', reply: 'Sem aceite.', terms: null, explicit_confirmation: false, terms_changed: false, purchase_acceptance: 'unclear' };
    // Keep phase checks contextual; never throw inside the mock HTTP handler.
    res.writeHead(200); return res.end(JSON.stringify(result));
  }
  res.writeHead(404); res.end('{}');
});
const agentPort = await listen(agent);
const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const env = { ...process.env, PORT: String(port), DATABASE_PATH: dbPath, INTERNAL_API_TOKEN: token,
  AGENT_URL: `http://127.0.0.1:${agentPort}`, TELEGRAM_API_URL: `http://127.0.0.1:${telegramPort}`,
  TELEGRAM_BOT_TOKEN: 'mock-token', TELEGRAM_ALLOWED_CHAT_IDS: supplierChat, TELEGRAM_WEBHOOK_SECRET: webhookSecret };
const apiDir = new URL('..', import.meta.url).pathname;

function startApi() {
  const proc = spawn(process.execPath, existsSync(join(apiDir, 'dist/main.js')) ? ['dist/main.js'] : ['--import', 'tsx', 'src/main.ts'], { cwd: apiDir, env, stdio: ['ignore', 'pipe', 'pipe'] });
  proc.stdout.on('data', chunk => logs += chunk); proc.stderr.on('data', chunk => logs += chunk);
  return proc;
}
async function waitReady(proc) {
  for (let i = 0; i < 120; i++) {
    if (proc.exitCode !== null) throw new Error(`Nest encerrou na inicialização: ${logs}`);
    try { if ((await fetch(`${base}/health`, { signal: AbortSignal.timeout(500) })).ok) return; } catch {}
    await delay(100);
  }
  throw new Error(`Timeout iniciando Nest: ${logs}`);
}
function purchaseTrace(id) {
  const db = new Database(dbPath);
  try {
    const outbox = db.prepare('SELECT * FROM purchase_outbox WHERE request_id=? ORDER BY created_at DESC LIMIT 1').get(id);
    const delivery = outbox?.delivery_id ? db.prepare('SELECT * FROM telegram_delivery WHERE id=?').get(outbox.delivery_id) : null;
    const mapping = delivery ? db.prepare('SELECT chat_id,message_id,request_id FROM telegram_outbound WHERE request_id=? AND chat_id=? ORDER BY message_id DESC').all(id, delivery.chat_id) : [];
    const simulation = outbox ? db.prepare('SELECT * FROM purchase_simulations WHERE id=?').get(outbox.simulation_id) : null;
    const request = db.prepare('SELECT * FROM requests WHERE id=?').get(id);
    const quote = outbox ? db.prepare('SELECT * FROM quotes WHERE id=?').get(outbox.quote_id) : null;
    return { outbox, delivery, mapping, simulation, request, quote };
  } finally { db.close(); }
}
async function waitForPurchaseDelivery(id, timeout = 10000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const trace = purchaseTrace(id);
    const mock = trace.delivery && telegramSends.find(send => send.payload.text === trace.delivery.message_text);
    const mapped = mock && trace.mapping.some(row => row.message_id === mock.messageId && row.chat_id === trace.outbox.chat_id);
    if (trace.outbox?.status === 'sent' && trace.delivery?.status === 'sent' && mapped) return { ...trace, messageId: mock.messageId };
    await delay(100);
  }
  throw new Error(`purchase outbox/delivery/message mapping was not completed for ${id}: ${JSON.stringify(purchaseTrace(id))}`);
}
async function waitForOutboundMessage(id, timeout = 5000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const db = new Database(dbPath);
    try {
      const row = db.prepare('SELECT message_id FROM telegram_outbound WHERE request_id=? ORDER BY message_id LIMIT 1').get(id);
      if (row) return row.message_id;
    } finally { db.close(); }
    await delay(100);
  }
  throw new Error(`initial Telegram message was not mapped for ${id}`);
}
function assertAgentPhase(stageName) {
  const observed = agentPhaseObservations.filter(row => row.stage === stageName);
  const expected = expectedAgentPhase.get(stageName);
  assert.ok(observed.length, `mock observation missing: endpoint=POST /conversation-turn stage=${stageName} expectedPhase=${expected}`);
  for (const row of observed) {
    assert.equal(row.phase, expected,
      `agent phase mismatch: endpoint=POST ${row.endpoint} stage=${row.stage} mode=${row.mode} expected=${expected} actual=${row.phase} message=${row.message}`);
  }
}
async function stopApi() {
  if (!child || child.exitCode !== null) return;
  const proc = child;
  await Promise.race([new Promise(resolve => proc.once('exit', resolve)), (async () => { proc.kill('SIGTERM'); await delay(3000); if (proc.exitCode === null) proc.kill('SIGKILL'); })()]);
}
async function json(path, method = 'GET', body, headers = {}) {
  const response = await fetch(`${base}${path}`, { method, headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000) });
  const text = await response.text(); let data; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: response.status, body: data };
}
function seedCompletedQuote(id, chat = supplierChat) {
  const db = new Database(dbPath);
  try {
    const request = db.prepare('SELECT * FROM requests WHERE id=?').get(id);
    const quoteId = `quote-${id}`;
    const timestamp = new Date().toISOString();
    db.prepare(`INSERT INTO quotes(id,request_id,event_id,supplier,unit_cents,shipping_cents,fees_cents,lead_days,available_qty,conditions,product_confirmed,destination_confirmed,created_at,supplier_chat_id)
      VALUES(?,?,?, ?,1250,200,50,3,20,'termos locais',1,1,?,?)`).run(quoteId, id, `fixture-${id}`, 'Fornecedor Simulado', timestamp, chat);
    const snapshot = JSON.stringify({ supplier: 'Fornecedor Simulado', unit_cents: 1250, shipping_cents: 200, fees_cents: 50, lead_days: 3,
      available_qty: 20, conditions: 'termos locais', product_confirmed: true, destination_confirmed: true });
    db.prepare("UPDATE requests SET status='comparação',quote_completion_state='concluida',quote_terms_snapshot=?,completed_quote_id=?,version=version+1 WHERE id=?")
      .run(snapshot, quoteId, id);
    return { quoteId, snapshot };
  } finally { db.close(); }
}
async function newCompletedRequest(product, chat = supplierChat) {
  const created = await json('/requests', 'POST', { product, specs: {}, qty: 2, destination: '01001-000' });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const fixture = seedCompletedQuote(created.body.id, chat);
  return { id: created.body.id, ...fixture };
}
async function webhook(id, updateId, text, chat = supplierChat, replyToMessageId) {
  const db = new Database(dbPath);
  let parent;
  try { parent = replyToMessageId ?? db.prepare('SELECT message_id FROM telegram_outbound WHERE chat_id=? AND request_id=? ORDER BY message_id DESC LIMIT 1').get(String(chat === '67890' ? supplierChat : chat), id)?.message_id; }
  finally { db.close(); }
  assert.ok(parent, `sem mensagem Telegram mapeada para request ${id}`);
  return json('/webhook/telegram', 'POST', { update_id: updateId, message: { text, chat: { id: Number(chat) }, from: { id: Number(chat) }, reply_to_message: { message_id: parent } } },
    { 'x-telegram-bot-api-secret-token': webhookSecret });
}

try {
  child = startApi(); await waitReady(child);
  // Creation contract and agent task dispatch stay entirely inside the two local mocks.
  const created = await json('/requests', 'POST', { product: 'Item de integração', specs: { cor: 'azul' }, qty: 2, destination: '01001-000' });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.product, 'Item de integração');
  await delay(100);

  // A complete quote is insufficient without the buyer's explicit approval.
  const unapproved = await newCompletedRequest('Cotação sem aprovação');
  let req = (await json(`/requests/${unapproved.id}`)).body;
  assert.equal((await json(`/requests/${unapproved.id}/decision`, 'POST', { quote_id: unapproved.quoteId, version: req.version }, { 'idempotency-key': 'missing-confirmation' })).status, 400);
  assert.equal((await json(`/requests/${unapproved.id}/decision`, 'POST', { quote_id: unapproved.quoteId, version: req.version, confirmed: false }, { 'idempotency-key': 'false-confirmation' })).status, 400);
  assert.equal((await json(`/requests/${unapproved.id}/purchase-simulation`)).body, null);

  // Acceptance creates one simulation and one queued outbox row. Same-key retry is idempotent;
  // another click/key cannot create a second order. Request version is required every time.
  const purchase = await newCompletedRequest('Compra simulada');
  const openingMessageId = await waitForOutboundMessage(purchase.id);
  // A supplier acceptance replying to the earlier quote request cannot confirm a purchase
  // simulation that the buyer has not approved and that has not yet been sent.
  stage = 'early-acceptance-before-buyer-approval';
  mode = 'accept';
  const earlyAcceptance = await webhook(purchase.id, 50999, 'Aceito', supplierChat, openingMessageId);
  assert.equal(earlyAcceptance.status, 200);
  assertAgentPhase(stage);
  assert.equal((await json(`/requests/${purchase.id}/purchase-simulation`)).body, null, 'early acceptance cannot create or confirm a purchase');
  req = (await json(`/requests/${purchase.id}`)).body;
  const decisionBody = { quote_id: purchase.quoteId, version: req.version, confirmed: true };
  const approved = await json(`/requests/${purchase.id}/decision`, 'POST', decisionBody, { 'idempotency-key': 'buyer-approval-1' });
  assert.equal(approved.status, 201, JSON.stringify(approved.body));
  assert.equal(approved.body.purchase_simulation.status, 'awaiting_supplier');
  let db = new Database(dbPath);
  try {
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM purchase_outbox WHERE request_id=? AND status=\'queued\'').get(purchase.id).n, 1, 'approval automatically queues exactly one supplier message');
    assert.equal(db.prepare('SELECT chat_id FROM purchase_outbox WHERE request_id=?').get(purchase.id).chat_id, supplierChat);
  } finally { db.close(); }
  const retry = await json(`/requests/${purchase.id}/decision`, 'POST', decisionBody, { 'idempotency-key': 'buyer-approval-1' });
  assert.equal(retry.status, 201); assert.equal(retry.body.purchase_simulation.id, approved.body.purchase_simulation.id);
  const secondClick = await json(`/requests/${purchase.id}/decision`, 'POST', { ...decisionBody, version: approved.body.version }, { 'idempotency-key': 'buyer-approval-2' });
  assert.equal(secondClick.status, 400, 'second click with a new idempotency key cannot duplicate');
  db = new Database(dbPath); try { assert.equal(db.prepare('SELECT COUNT(*) AS n FROM purchase_simulations WHERE request_id=?').get(purchase.id).n, 1); } finally { db.close(); }

  const orderTrace = await waitForPurchaseDelivery(purchase.id, 10000);
  assert.ok(orderTrace.outbox.delivery_id, 'outbox persists a stable delivery id');
  assert.equal(orderTrace.delivery.id, orderTrace.outbox.delivery_id);
  assert.equal(orderTrace.delivery.request_id, purchase.id);
  assert.equal(orderTrace.delivery.chat_id, supplierChat);
  assert.equal(orderTrace.delivery.status, 'sent');
  assert.equal(orderTrace.outbox.status, 'sent');
  assert.equal(orderTrace.mapping.some(row => row.message_id === orderTrace.messageId && row.request_id === purchase.id), true,
    'mock Telegram message id is mapped to the purchase request');
  const orderText = orderTrace.delivery.message_text;
  assert.match(orderText, /SIMULAÇÃO DE PEDIDO/);
  assert.match(orderText, /sem cobrança/i);
  assert.match(orderText, /Compra simulada/);
  assert.match(orderText, /Quantidade: 2/);
  assert.match(orderText, /01001-000/);
  assert.match(orderText, /12,50/);
  assert.match(orderText, /Frete:.*2,00.*Taxas:.*0,50/);
  assert.match(orderText, /27,50/);
  const savedSnapshot = JSON.parse(orderTrace.simulation.snapshot);
  assert.equal(savedSnapshot.unit_cents, orderTrace.quote.unit_cents);
  assert.equal(savedSnapshot.shipping_cents, orderTrace.quote.shipping_cents);
  assert.equal(savedSnapshot.fees_cents, orderTrace.quote.fees_cents);
  assert.equal(savedSnapshot.lead_days, orderTrace.quote.lead_days);
  assert.equal(savedSnapshot.available_qty, orderTrace.quote.available_qty);
  assert.equal(orderTrace.request.qty, 2);

  // A foreign supplier cannot confirm even when replying to the exact simulated order message.
  stage = 'accept-simulated-order';
  mode = 'accept';
  const wrong = await webhook(purchase.id, 51001, 'Aceito', '67890', orderTrace.messageId);
  assert.equal(wrong.body.ignored, 'unauthorized-chat');
  assert.equal((await json(`/requests/${purchase.id}/purchase-simulation`)).body.status, 'awaiting_supplier');
  const accepted = await webhook(purchase.id, 51002, 'Aceito', supplierChat, orderTrace.messageId);
  assert.equal(accepted.status, 200); assert.equal(accepted.body.pending, false);
  assertAgentPhase(stage);
  assert.equal((await json(`/requests/${purchase.id}/purchase-simulation`)).body.status, 'confirmed');

  // Duplicate supplier update is idempotent, including after an API process restart.
  const sendsAfterAccept = telegramSends.length;
  const duplicate = await webhook(purchase.id, 51002, 'Aceito');
  assert.equal(duplicate.body.duplicate, true);
  await stopApi(); child = startApi(); await waitReady(child);
  assert.equal((await json(`/requests/${purchase.id}/purchase-simulation`)).body.status, 'confirmed');
  assert.equal(telegramSends.length, sendsAfterAccept, 'restart and duplicate update do not send again');

  // A changed quote snapshot invalidates the supplier approval and requires buyer review.
  const changed = await newCompletedRequest('Mudança de snapshot');
  req = (await json(`/requests/${changed.id}`)).body;
  const changeApproval = await json(`/requests/${changed.id}/decision`, 'POST', { quote_id: changed.quoteId, version: req.version, confirmed: true }, { 'idempotency-key': 'changed-terms-approval' });
  assert.equal(changeApproval.status, 201);
  const oldOrderTrace = await waitForPurchaseDelivery(changed.id, 10000);
  const oldSimulationId = oldOrderTrace.simulation.id;
  const oldOutboxId = oldOrderTrace.outbox.id;
  stage = 'reprice-via-old-order';
  mode = 'reprice-accept';
  const changedReply = await webhook(changed.id, 52001, 'Aceito, mas alterei o preço', supplierChat, oldOrderTrace.messageId);
  assert.equal(changedReply.status, 200);
  assertAgentPhase(stage);
  assert.equal((await json(`/requests/${changed.id}/purchase-simulation`)).body.status, 'review_required', 'new terms must not inherit supplier acceptance');
  stage = 'stale-old-order-after-reprice';
  mode = 'accept';
  await webhook(changed.id, 52002, 'Aceito', supplierChat, oldOrderTrace.messageId);
  assertAgentPhase(stage);
  assert.equal((await json(`/requests/${changed.id}/purchase-simulation`)).body.status, 'review_required', 'reply to the old order cannot approve repriced terms');
  mode = 'quote-confirm';
  const revisedTermsConfirmation = await webhook(changed.id, 52003, 'Confirmo os novos termos', supplierChat, oldOrderTrace.messageId);
  assert.equal(revisedTermsConfirmation.status, 200);
  let revisedRequest = (await json(`/requests/${changed.id}`)).body;
  assert.equal(revisedRequest.quote_completion_state, 'concluida');
  const revisedQuote = revisedRequest.quotes.find(row => row.id === revisedRequest.completed_quote_id);
  assert.ok(revisedQuote);
  assert.equal(revisedQuote.unit_cents, 1300);
  const reapproval = await json(`/requests/${changed.id}/decision`, 'POST', {
    quote_id: revisedQuote.id, version: revisedRequest.version, confirmed: true,
  }, { 'idempotency-key': 'reapprove-repriced-terms' });
  assert.equal(reapproval.status, 201, JSON.stringify(reapproval.body));
  assert.equal(reapproval.body.purchase_simulation.status, 'awaiting_supplier');
  const newOrderTrace = await waitForPurchaseDelivery(changed.id, 10000);
  assert.notEqual(newOrderTrace.simulation.id, oldSimulationId, 'human reapproval creates a fresh simulation');
  assert.notEqual(newOrderTrace.outbox.id, oldOutboxId, 'human reapproval creates a fresh outbox item');
  assert.notEqual(newOrderTrace.messageId, oldOrderTrace.messageId, 'repriced order is sent as a new Telegram message');
  assert.match(newOrderTrace.delivery.message_text, /13,00/);
  assert.match(newOrderTrace.delivery.message_text, /28,50/);
  stage = 'stale-old-order-after-reapproval';
  mode = 'accept';
  await webhook(changed.id, 52004, 'Aceito', supplierChat, oldOrderTrace.messageId);
  assertAgentPhase(stage);
  assert.equal((await json(`/requests/${changed.id}/purchase-simulation`)).body.status, 'awaiting_supplier', 'old order reply cannot confirm the reapproved simulation');

  // Cancellation closes both the simulation and its still queued outbox item.
  const cancelCase = await newCompletedRequest('Compra cancelável');
  req = (await json(`/requests/${cancelCase.id}`)).body;
  const cancelApproval = await json(`/requests/${cancelCase.id}/decision`, 'POST', { quote_id: cancelCase.quoteId, version: req.version, confirmed: true }, { 'idempotency-key': 'cancel-approval' });
  assert.equal(cancelApproval.status, 201);
  const cancelled = await json(`/requests/${cancelCase.id}/purchase-simulation/cancel`, 'POST', {});
  assert.equal(cancelled.status, 201);
  assert.equal(cancelled.body.purchase_simulation.status, 'cancelled');
  db = new Database(dbPath); try { assert.equal(db.prepare('SELECT status FROM purchase_outbox WHERE request_id=?').get(cancelCase.id).status, 'cancelled'); } finally { db.close(); }
  assert.equal((await json(`/requests/${cancelCase.id}/purchase-simulation/cancel`, 'POST', {})).body.purchase_simulation.status, 'cancelled');

  // Buyer can also register or clear a preference for a web/market option once quotation is completed,
  // and starting a supplier purchase simulation clears any prior market preference.
  const marketCase = await newCompletedRequest('Preferência da internet');
  const marketQuoteId = `web-${marketCase.id}`;
  db = new Database(dbPath);
  try {
    db.prepare(`INSERT INTO quotes(id,request_id,event_id,supplier,unit_cents,shipping_cents,fees_cents,lead_days,available_qty,conditions,product_confirmed,destination_confirmed,source_url,created_at)
      VALUES(?,?,?,?,1190,null,null,null,null,'Loja Online | https://loja.example/oferta',1,0,'https://loja.example/oferta',?)`)
      .run(marketQuoteId, marketCase.id, `web-ev-${marketCase.id}`, 'Loja Online', new Date().toISOString());
  } finally { db.close(); }
  req = (await json(`/requests/${marketCase.id}`)).body;
  assert.equal((await json(`/requests/${marketCase.id}/market-preference`, 'POST', { quote_id: marketCase.quoteId, version: req.version })).status, 400, 'Telegram quote cannot be chosen as internet option');
  const preferred = await json(`/requests/${marketCase.id}/market-preference`, 'POST', { quote_id: marketQuoteId, version: req.version });
  assert.equal(preferred.status, 201, JSON.stringify(preferred.body));
  assert.equal(preferred.body.preferred_market_quote_id, marketQuoteId);
  assert.ok(preferred.body.preferred_market_at);
  const cleared = await json(`/requests/${marketCase.id}/market-preference`, 'POST', { quote_id: null, version: preferred.body.version });
  assert.equal(cleared.status, 201);
  assert.equal(cleared.body.preferred_market_quote_id, null);
  const reselected = await json(`/requests/${marketCase.id}/market-preference`, 'POST', { quote_id: marketQuoteId, version: cleared.body.version });
  assert.equal(reselected.status, 201);
  const switchToSupplier = await json(`/requests/${marketCase.id}/decision`, 'POST', { quote_id: marketCase.quoteId, version: reselected.body.version, confirmed: true }, { 'idempotency-key': 'switch-to-supplier' });
  assert.equal(switchToSupplier.status, 201);
  assert.equal(switchToSupplier.body.preferred_market_quote_id, null, 'supplier simulation clears internet preference');
  assert.equal((await json(`/requests/${marketCase.id}/market-preference`, 'POST', { quote_id: marketQuoteId, version: switchToSupplier.body.version })).status, 400, 'cannot set internet preference while supplier simulation is active');

  console.log('PASS purchase simulation: buyer approval gate; early/wrong/stale supplier acceptance rejected; sent outbox, delivery id and Telegram message mapping; order terms/snapshot; idempotent clicks and duplicate update; repricing, supplier reconfirmation, human reapproval and new simulated order; cancel; restart. Loopback mocks only.');
} catch (error) {
  console.error(`FAIL purchase simulation: ${error.stack || error}\nNest logs:\n${logs}`);
  process.exitCode = 1;
} finally {
  await stopApi(); await close(agent); await close(telegram);
  rmSync(dir, { recursive: true, force: true });
}
