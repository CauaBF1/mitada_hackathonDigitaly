import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'nexo-voice-webrtc-'));
const dbPath = join(dir, 'business.sqlite');
const waSends = [];
const tgSends = [];

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
async function start() {
  child = spawn(process.execPath, ['dist/main.js'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PORT: String(port),
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
      VAPI_API_KEY: 'vapi-pub-test',
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

try {
  await start();

  // 1. Create request and verify Telegram invite link contains /call/[id]
  const created = await json('/requests', {
    product: 'Notebook corporativo i7',
    qty: 5,
    destination: '01310-100',
    specs: { ram: '16GB' },
  });
  assert.equal(created.status, 201);
  const reqId = created.body.id;
  assert.equal(tgSends.length, 1);
  assert.match(tgSends[0].text, /Ligação de Voz Nexo/);
  assert.match(tgSends[0].text, new RegExp(`http://localhost:3000/call/${reqId}`));

  // Register WhatsApp contact
  const regWa = await json(
    `/requests/${reqId}/whatsapp`,
    { supplier_id: 'fornecedor-voz', name: 'Tech Distribuidora', number: '5511977776666' },
    { authorization: 'Bearer internal-test' }
  );
  assert.equal(regWa.status, 201);

  // 2. Check GET /call-session/:id
  const session = await json(`/call-session/${reqId}`);
  assert.equal(session.status, 200);
  assert.equal(session.body.product, 'Notebook corporativo i7');
  assert.equal(session.body.qty, 5);
  assert.equal(session.body.destination, '01310-100');
  assert.equal(session.body.vapi_public_key, 'vapi-pub-test');
  assert.equal(session.body.assistant_id, 'vapi-asst-test');

  // 3. Call failure / mic denied via POST /call-session/:id/end -> triggers dual fallback (Telegram + WhatsApp)
  const tgBeforeFail = tgSends.length;
  const waBeforeFail = waSends.length;
  const failEnd = await json(`/call-session/${reqId}/end`, {
    call_id: 'webcall-fail-1',
    status: 'failed',
    quote_completed: false,
  });
  assert.equal(failEnd.status, 200);
  assert.equal(tgSends.length, tgBeforeFail + 1);
  assert.equal(waSends.length, waBeforeFail + 1);
  assert.match(tgSends.at(-1).text, /tentativa de ligação de voz/i);
  assert.match(waSends.at(-1).text, /por ligação de voz, mas a chamada não foi concluída/i);
  assert.match(failEnd.body.request.notice, /Fallback efetuado/);

  // Idempotency: duplicate call-end with same call_id does not resend
  await json(`/call-session/${reqId}/end`, {
    call_id: 'webcall-fail-1',
    status: 'failed',
    quote_completed: false,
  });
  assert.equal(tgSends.length, tgBeforeFail + 1);
  assert.equal(waSends.length, waBeforeFail + 1);

  // 4. Partial voice quote (missing shipping_fee / lead_days) -> keeps status='comparação', state='coletando' and sends partial fallback
  const partialRes = await json(
    '/webhook/voice',
    {
      message: {
        type: 'end-of-call-report',
        endedReason: 'customer-ended-call',
        call: {
          id: 'webcall-partial-1',
          metadata: {
            request_id: reqId,
            supplier_id: 'fornecedor-voz',
            supplier_name: 'Tech Distribuidora',
          },
          artifact: {
            messages: [
              { role: 'assistant', message: 'Qual o preço unitário?' },
              { role: 'user', message: 'Consigo fazer R$ 3500,00 cada, temos 10 em estoque.' },
              {
                role: 'assistant',
                toolCalls: [
                  {
                    id: 'tc-1',
                    function: {
                      name: 'submit_procurement_quote',
                      arguments: JSON.stringify({
                        initial_price: '3600.00',
                        final_price: '3500.00',
                        qty: 10,
                        product_confirmed: true,
                        destination_confirmed: true,
                        supplier_confirmed: false,
                      }),
                    },
                  },
                ],
              },
            ],
          },
        },
      },
    },
    { 'x-voice-webhook-secret': 'voice-secret' }
  );
  assert.equal(partialRes.status, 200);
  const afterPartial = (await json(`/requests/${reqId}`)).body;
  assert.equal(afterPartial.status, 'comparação');
  assert.equal(afterPartial.quote_completion_state, 'coletando');
  assert.equal(afterPartial.quotes.length, 1);
  assert.equal(afterPartial.quotes[0].event_id, 'voice:webcall-partial-1');
  assert.equal(afterPartial.quotes[0].unit_cents, 350000);
  assert.equal(afterPartial.quotes[0].eligible, false);
  assert.ok(afterPartial.supplier_draft.missing_fields.includes('shipping_cents'));

  // 5. Complete voice quote with supplier_confirmed=true -> status='concluida', quote_completion_state='concluida', completed_quote_id set
  const completeRes = await json(`/call-session/${reqId}/end`, {
    call_id: 'webcall-complete-1',
    status: 'completed',
    quote_completed: true,
    supplier_id: 'fornecedor-voz',
    supplier_name: 'Tech Distribuidora',
    transcript: [
      { sender_type: 'AI', content: 'Olá! Podemos confirmar frete, taxas e prazo?' },
      { sender_type: 'SUPPLIER', content: 'Preço final R$ 3400,00, frete R$ 50,00, sem taxas, entrega em 3 dias, 10 em estoque. Confirmo a proposta!' },
    ],
    quote: {
      initial_price: '3600.00',
      final_price: '3400.00',
      shipping_fee: '50.00',
      fees: '0.00',
      lead_days: 3,
      qty: 10,
      delivery_time: '3 dias úteis',
      conditions: 'PIX ou boleto 30 dias',
      product_confirmed: true,
      destination_confirmed: true,
      supplier_confirmed: true,
    },
  });
  assert.equal(completeRes.status, 200);
  assert.equal(completeRes.body.quote_completed, true);

  const afterComplete = (await json(`/requests/${reqId}`)).body;
  assert.equal(afterComplete.status, 'concluida');
  assert.equal(afterComplete.quote_completion_state, 'concluida');
  assert.ok(afterComplete.completed_quote_id);
  const completedQuote = afterComplete.quotes.find((q) => q.id === afterComplete.completed_quote_id);
  assert.ok(completedQuote);
  assert.equal(completedQuote.event_id, 'voice:webcall-complete-1');
  assert.equal(completedQuote.unit_cents, 340000);
  assert.equal(completedQuote.shipping_cents, 5000);
  assert.equal(completedQuote.fees_cents, 0);
  assert.equal(completedQuote.lead_days, 3);
  assert.equal(completedQuote.available_qty, 10);
  assert.equal(completedQuote.eligible, true);
  assert.equal(completedQuote.tco_cents, 340000 * 5 + 5000);

  // 6. Verify HistoryService detail includes voice channel in quotes and conversations
  const hist = (await json(`/history/${reqId}`)).body;
  assert.ok(hist.quotes.some((q) => q.channel === 'voice' && q.eligible === true));
  assert.ok(hist.conversations.some((c) => c.channel === 'voice' && c.messages.length >= 2));

  // 7. Verify human decision / purchase simulation works on the completed voice quote
  const decided = await json(
    `/requests/${reqId}/decision`,
    {
      quote_id: afterComplete.completed_quote_id,
      version: afterComplete.version,
      confirmed: true,
    },
    { 'idempotency-key': 'voice-sim-key-1' }
  );
  assert.equal(decided.status, 201);
  assert.equal(decided.body.status, 'decidida');
  assert.equal(decided.body.purchase_simulation.status, 'awaiting_supplier');

  // 8. Verify POST /requests/:id/call-supplier in WebRTC mode sends invite link
  const created2 = await json('/requests', {
    product: 'Monitor 27 4K',
    qty: 3,
    destination: '04538-132',
    specs: { painel: 'IPS' },
  });
  const req2Id = created2.body.id;
  const callWeb = await json(`/requests/${req2Id}/call-supplier`, {});
  assert.equal(callWeb.status, 201);
  assert.equal(callWeb.body.mode, 'webrtc');
  assert.equal(callWeb.body.call_url, `http://localhost:3000/call/${req2Id}`);

  console.log('PASS Voice WebRTC Full-Duplex smoke: invite link, call-session, dual fallback, partial draft, completed voice quote, purchase simulation, Kanban & History');
} finally {
  await stop().catch(() => {});
  await new Promise((resolve) => fake.close(resolve));
  rmSync(dir, { recursive: true, force: true });
}
