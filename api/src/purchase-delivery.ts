import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';

type PurchaseRow = {
  id: string;
  simulation_id: string;
  request_id: string;
  quote_id: string;
  chat_id: string;
  status: string;
  created_at: string;
  attempts: number;
  next_attempt_at: string | null;
  delivery_id: string | null;
};

type RequestRow = {
  id: string;
  product: string;
  qty: number;
  destination: string;
  status: string;
  decision: string | null;
  quote_completion_state: string | null;
  quote_terms_snapshot: string | null;
};

type QuoteRow = {
  id: string;
  request_id: string;
  supplier: string;
  unit_cents: number;
  shipping_cents: number | null;
  fees_cents: number | null;
  lead_days: number | null;
  available_qty: number | null;
  conditions: string | null;
  product_confirmed: number;
  destination_confirmed: number;
};

type SimulationRow = {
  id: string;
  request_id: string;
  quote_id: string;
  snapshot: string;
  status: string;
};

const MAX_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [5_000, 30_000, 120_000];

function ensureOutboxColumns(db: Database.Database): void {
  const existing = new Set((db.prepare('PRAGMA table_info(purchase_outbox)').all() as Array<{ name: string }>).map(column => column.name));
  if (!existing.has('attempts')) db.exec('ALTER TABLE purchase_outbox ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0');
  if (!existing.has('next_attempt_at')) db.exec('ALTER TABLE purchase_outbox ADD COLUMN next_attempt_at TEXT');
  if (!existing.has('delivery_id')) db.exec('ALTER TABLE purchase_outbox ADD COLUMN delivery_id TEXT');
}

function expectedSnapshot(quote: QuoteRow): string {
  return JSON.stringify({
    supplier: quote.supplier,
    unit_cents: quote.unit_cents,
    shipping_cents: quote.shipping_cents,
    fees_cents: quote.fees_cents,
    lead_days: quote.lead_days,
    available_qty: quote.available_qty,
    conditions: quote.conditions || '',
    product_confirmed: !!quote.product_confirmed,
    destination_confirmed: !!quote.destination_confirmed,
  });
}

function formatMoney(cents: number): string {
  return (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function purchaseMessage(request: RequestRow, quote: QuoteRow, snapshot: Record<string, unknown>): string {
  const unitCents = Number(snapshot.unit_cents);
  const shippingCents = Number(snapshot.shipping_cents);
  const feesCents = Number(snapshot.fees_cents);
  const quantity = request.qty;
  const totalCents = unitCents * quantity + shippingCents + feesCents;
  return [
    'SIMULAÇÃO DE PEDIDO — sem cobrança e sem compromisso de compra.',
    `Produto: ${request.product}`,
    `Quantidade: ${quantity} un.`,
    `Destino: ${request.destination}`,
    `Fornecedor: ${quote.supplier}`,
    `Preço unitário: ${formatMoney(unitCents)}`,
    `Frete: ${formatMoney(shippingCents)} | Taxas: ${formatMoney(feesCents)}`,
    `Prazo: ${snapshot.lead_days} dias | Disponibilidade informada: ${snapshot.available_qty} un.`,
    `Total estimado: ${formatMoney(totalCents)}`,
    `Condições: ${String(snapshot.conditions || 'não informadas')}`,
    'Pode confirmar o aceite destas condições?',
  ].join('\n');
}

/** Dispatches simulated purchase orders through the injected Telegram sender. */
export async function dispatchPurchaseOutbox(
  db: Database.Database,
  send: (deliveryId: string, requestId: string, chatId: string, text: string) => Promise<boolean>,
): Promise<void> {
  ensureOutboxColumns(db);

  // A process restart while a request was in flight cannot establish whether Telegram accepted it.
  // Keep its stable delivery trace and make it terminal so a later pump cannot send it twice.
  const recoverInterrupted = db.transaction(() => {
    const interrupted = db.prepare("SELECT id,delivery_id,attempts FROM purchase_outbox WHERE status='sending'").all() as Array<{ id: string; delivery_id: string | null; attempts: number }>;
    for (const row of interrupted) {
      const delivery = row.delivery_id
        ? db.prepare('SELECT status FROM telegram_delivery WHERE id=?').get(row.delivery_id) as { status: string } | undefined
        : undefined;
      if (delivery?.status === 'sent') {
        db.prepare("UPDATE purchase_outbox SET status='sent',next_attempt_at=NULL WHERE id=? AND status='sending'").run(row.id);
        continue;
      }
      if (delivery?.status === 'failed') {
        const retryAt = row.attempts < MAX_ATTEMPTS ? new Date(Date.now() + RETRY_DELAYS_MS[row.attempts - 1]).toISOString() : null;
        db.prepare("UPDATE purchase_outbox SET status='failed',next_attempt_at=? WHERE id=? AND status='sending'").run(retryAt, row.id);
        continue;
      }
      if (row.delivery_id) {
        db.prepare("UPDATE telegram_delivery SET status='uncertain',error=COALESCE(error,'Process reiniciado durante o envio; resultado incerto.') WHERE id=? AND status='sending'").run(row.delivery_id);
      }
      db.prepare("UPDATE purchase_outbox SET status='uncertain' WHERE id=? AND status='sending'").run(row.id);
    }
  });
  recoverInterrupted();

  const claimNext = db.transaction((now: string): PurchaseRow | undefined => {
    const row = db.prepare(`SELECT * FROM purchase_outbox
      WHERE status='queued' OR (status='failed' AND attempts < ? AND (next_attempt_at IS NULL OR next_attempt_at <= ?))
      ORDER BY created_at,id LIMIT 1`).get(MAX_ATTEMPTS, now) as PurchaseRow | undefined;
    if (!row) return undefined;
    const deliveryId = row.delivery_id || randomUUID();
    const claimed = db.prepare(`UPDATE purchase_outbox
      SET status='sending',attempts=attempts+1,delivery_id=?,next_attempt_at=NULL
      WHERE id=? AND (status='queued' OR (status='failed' AND attempts < ? AND (next_attempt_at IS NULL OR next_attempt_at <= ?)))`).run(deliveryId, row.id, MAX_ATTEMPTS, now);
    if (!claimed.changes) return undefined;
    row.delivery_id = deliveryId;
    row.attempts += 1;
    row.status = 'sending';
    return row;
  });

  while (true) {
    const now = new Date().toISOString();
    const outbox = claimNext.immediate(now);
    if (!outbox) return;
    const deliveryId = outbox.delivery_id!;

    try {
      const prepared = db.transaction(() => {
        const simulation = db.prepare('SELECT id,request_id,quote_id,snapshot,status FROM purchase_simulations WHERE id=?').get(outbox.simulation_id) as SimulationRow | undefined;
        const request = db.prepare(`SELECT id,product,qty,destination,status,decision,quote_completion_state,quote_terms_snapshot
          FROM requests WHERE id=?`).get(outbox.request_id) as RequestRow | undefined;
        const quote = db.prepare(`SELECT id,request_id,supplier,unit_cents,shipping_cents,fees_cents,lead_days,available_qty,conditions,product_confirmed,destination_confirmed
          FROM quotes WHERE id=? AND request_id=?`).get(outbox.quote_id, outbox.request_id) as QuoteRow | undefined;

        if (!simulation || !request || !quote || simulation.request_id !== outbox.request_id || simulation.quote_id !== outbox.quote_id ||
            simulation.status !== 'awaiting_supplier' || request.status !== 'decidida' || request.decision !== outbox.quote_id ||
            request.quote_completion_state !== 'concluida' || !request.quote_terms_snapshot ||
            simulation.snapshot !== request.quote_terms_snapshot || simulation.snapshot !== expectedSnapshot(quote) ||
            quote.shipping_cents === null || quote.fees_cents === null || quote.lead_days === null || quote.available_qty === null ||
            quote.available_qty < request.qty || !quote.product_confirmed || !quote.destination_confirmed ||
            !Number.isSafeInteger(quote.unit_cents * request.qty + quote.shipping_cents + quote.fees_cents)) {
          db.prepare("UPDATE purchase_outbox SET status='cancelled',next_attempt_at=NULL WHERE id=? AND status='sending'").run(outbox.id);
          return undefined;
        }

        const snapshot = JSON.parse(simulation.snapshot) as Record<string, unknown>;
        const text = purchaseMessage(request, quote, snapshot);
        db.prepare(`INSERT OR IGNORE INTO telegram_delivery
          (id,request_id,chat_id,status,error,created_at,message_text)
          VALUES(?,?,?,'sending',NULL,?,?)`).run(deliveryId, outbox.request_id, outbox.chat_id, new Date().toISOString(), text);
        const delivery = db.prepare('SELECT request_id,chat_id,message_text,status FROM telegram_delivery WHERE id=?').get(deliveryId) as
          { request_id: string; chat_id: string; message_text: string | null; status: string } | undefined;
        if (!delivery || delivery.request_id !== outbox.request_id || delivery.chat_id !== outbox.chat_id || delivery.message_text !== text) {
          db.prepare("UPDATE purchase_outbox SET status='uncertain',next_attempt_at=NULL WHERE id=? AND status='sending'").run(outbox.id);
          return undefined;
        }
        if (delivery.status === 'failed' && outbox.attempts > 1) {
          db.prepare("UPDATE telegram_delivery SET status='sending',error=NULL,created_at=?,message_text=? WHERE id=? AND status='failed'").run(new Date().toISOString(), text, deliveryId);
        } else if (delivery.status !== 'sending') {
          db.prepare("UPDATE purchase_outbox SET status='uncertain',next_attempt_at=NULL WHERE id=? AND status='sending'").run(outbox.id);
          return undefined;
        }
        return { text };
      })();
      if (!prepared) continue;

      let sent = false;
      try {
        sent = await send(deliveryId, outbox.request_id, outbox.chat_id, prepared.text);
      } catch (error) {
        const reason = `Callback de envio falhou (${error instanceof Error ? error.name : 'erro'}).`;
        db.prepare("UPDATE telegram_delivery SET status='failed',error=? WHERE id=? AND status='sending'").run(reason, deliveryId);
      }

      const delivery = db.prepare('SELECT status FROM telegram_delivery WHERE id=?').get(deliveryId) as { status: string } | undefined;
      if (sent) {
        db.prepare("UPDATE purchase_outbox SET status='sent',next_attempt_at=NULL WHERE id=? AND status='sending'").run(outbox.id);
      } else if (delivery?.status === 'uncertain' || delivery?.status === 'sending' || !delivery) {
        if (delivery?.status === 'sending') db.prepare("UPDATE telegram_delivery SET status='uncertain',error=COALESCE(error,'Callback retornou sem confirmação do Telegram.') WHERE id=? AND status='sending'").run(deliveryId);
        db.prepare("UPDATE purchase_outbox SET status='uncertain',next_attempt_at=NULL WHERE id=? AND status='sending'").run(outbox.id);
      } else if (delivery.status === 'failed') {
        const retryAt = outbox.attempts < MAX_ATTEMPTS ? new Date(Date.now() + RETRY_DELAYS_MS[outbox.attempts - 1]).toISOString() : null;
        db.prepare("UPDATE purchase_outbox SET status='failed',next_attempt_at=? WHERE id=? AND status='sending'").run(retryAt, outbox.id);
      } else if (delivery.status === 'sent') {
        db.prepare("UPDATE purchase_outbox SET status='sent',next_attempt_at=NULL WHERE id=? AND status='sending'").run(outbox.id);
      } else {
        db.prepare("UPDATE purchase_outbox SET status='uncertain',next_attempt_at=NULL WHERE id=? AND status='sending'").run(outbox.id);
      }
    } catch (error) {
      const reason = `Falha conhecida ao preparar envio (${error instanceof Error ? error.name : 'erro'}).`;
      db.prepare("UPDATE telegram_delivery SET status='failed',error=? WHERE id=? AND status='sending'").run(reason, deliveryId);
      const retryAt = outbox.attempts < MAX_ATTEMPTS ? new Date(Date.now() + RETRY_DELAYS_MS[outbox.attempts - 1]).toISOString() : null;
      db.prepare("UPDATE purchase_outbox SET status='failed',next_attempt_at=? WHERE id=? AND status='sending'").run(retryAt, outbox.id);
    }
  }
}
