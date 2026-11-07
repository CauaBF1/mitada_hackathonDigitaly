import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import Database from 'better-sqlite3';
import { createHash, timingSafeEqual } from 'node:crypto';

const now = () => new Date().toISOString();
const digest = (...parts: string[]) => createHash('sha256').update(JSON.stringify(parts)).digest('hex');
export function webhookAuth(received: string, expected: string) {
  const a = Buffer.from(received || ''), b = Buffer.from(expected || '');
  if (!b.length || a.length !== b.length || !timingSafeEqual(a, b)) throw new UnauthorizedException();
}

/** Business data stays in the same SQLite database as Telegram. Network I/O is outside transactions. */
export class WhatsAppService {
  private active = new Set<string>();
  constructor(private db: Database.Database, private getRequest: (id: string) => any,
    private addQuote: (id: string, quote: any) => any) {
    db.exec(`CREATE TABLE IF NOT EXISTS whatsapp_contacts(
      request_id TEXT NOT NULL REFERENCES requests(id), supplier_id TEXT NOT NULL, name TEXT NOT NULL,
      number TEXT NOT NULL, PRIMARY KEY(request_id,supplier_id), UNIQUE(request_id,number));
    CREATE TABLE IF NOT EXISTS whatsapp_delivery(
      id TEXT PRIMARY KEY, request_id TEXT NOT NULL, number TEXT NOT NULL, content TEXT NOT NULL,
      status TEXT NOT NULL, message_id TEXT, error TEXT, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS whatsapp_updates(
      id TEXT PRIMARY KEY, request_id TEXT NOT NULL, number TEXT NOT NULL, supplier_id TEXT NOT NULL,
      content TEXT NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
      answer TEXT, retry_after TEXT, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS whatsapp_quote_state(
      request_id TEXT NOT NULL, number TEXT NOT NULL, state TEXT NOT NULL, PRIMARY KEY(request_id,number));
    CREATE TABLE IF NOT EXISTS whatsapp_voice_calls(
      id TEXT PRIMARY KEY, request_id TEXT NOT NULL, supplier_id TEXT NOT NULL,
      quote_completed INTEGER NOT NULL DEFAULT 0);`);
    const columns = db.prepare('PRAGMA table_info(conversation_messages)').all() as any[];
    for (const [name, type] of [['channel', "TEXT NOT NULL DEFAULT 'telegram'"], ['external_message_id', 'TEXT']]) {
      if (!columns.some(c => c.name === name)) db.exec(`ALTER TABLE conversation_messages ADD COLUMN ${name} ${type}`);
    }
    // A crashed send may already have reached WhatsApp; never blindly resend it.
    db.prepare("UPDATE whatsapp_delivery SET status='uncertain' WHERE status='sending'").run();
    db.prepare("UPDATE conversation_messages SET delivery_status='uncertain' WHERE channel='whatsapp' AND delivery_status='sending'").run();
    db.prepare("UPDATE whatsapp_updates SET status=CASE WHEN answer IS NOT NULL THEN 'ready' ELSE 'pending' END WHERE status='processing'").run();
    db.prepare("UPDATE whatsapp_updates SET status='exhausted' WHERE status IN ('pending','ready') AND attempts>=3").run();
  }

  register(id: string, body: any) {
    if (this.getRequest(id).status === 'decidida') throw new BadRequestException('Solicitação decidida.');
    const number = typeof body?.number === 'string' ? body.number.replace(/^\+/, '') : '';
    if (!/^[1-9]\d{6,14}$/.test(number) || typeof body?.supplier_id !== 'string' ||
      !/^[\w-]{1,100}$/.test(body.supplier_id) || typeof body?.name !== 'string' || !body.name.trim() || body.name.length > 200)
      throw new BadRequestException('Informe supplier_id, name e number com DDI (ex.: +5511999999999).');
    const existing = this.db.prepare('SELECT * FROM whatsapp_contacts WHERE request_id=? AND (supplier_id=? OR number=?)').all(id, body.supplier_id, number) as any[];
    if (existing.some(c => c.number !== number || c.supplier_id !== body.supplier_id))
      throw new BadRequestException('Contato já vinculado; não é permitido trocar o fornecedor de uma conversa.');
    this.db.prepare(`INSERT INTO whatsapp_contacts VALUES(?,?,?,?) ON CONFLICT(request_id,supplier_id) DO UPDATE SET name=excluded.name`)
      .run(id, body.supplier_id, body.name.trim(), number);
    return { request_id: id, supplier_id: body.supplier_id, number };
  }

  async sendWhatsApp(id: string, number: string, text: string, key: string) {
    const deliveryId = digest(id, number, key);
    const previous = this.db.prepare('SELECT * FROM whatsapp_delivery WHERE id=?').get(deliveryId) as any;
    if (previous) return { ok: previous.status === 'sent', status: previous.status, message_id: previous.message_id };
    if (this.getRequest(id).status === 'decidida') throw new BadRequestException('Solicitação decidida.');
    if (!process.env.WHATSAPP_API_URL || !process.env.WHATSAPP_API_KEY || !process.env.WHATSAPP_INSTANCE_NAME)
      throw new BadRequestException('WhatsApp não configurado.');
    this.db.transaction(() => {
      this.db.prepare("INSERT INTO whatsapp_delivery VALUES(?,?,?,?,'sending',NULL,NULL,?)").run(deliveryId, id, number, text, now());
      this.db.prepare(`INSERT INTO conversation_messages(id,request_id,chat_id,sender_type,content,delivery_status,channel,created_at)
        VALUES(?,?,?,'AI',?,'sending','whatsapp',?)`).run(deliveryId, id, number, text, now());
    })();
    let status = 'uncertain', messageId: string | null = null, error: string | null = null;
    try {
      const response = await fetch(`${process.env.WHATSAPP_API_URL.replace(/\/$/, '')}/message/sendText/${encodeURIComponent(process.env.WHATSAPP_INSTANCE_NAME)}`, {
        method: 'POST', headers: { 'content-type': 'application/json', apikey: process.env.WHATSAPP_API_KEY },
        body: JSON.stringify({ number, text }), signal: AbortSignal.timeout(8000),
      });
      if (!response.ok) {
        // 5xx may occur after acceptance; only explicit client rejection is known to be failed.
        status = response.status >= 400 && response.status < 500 ? 'failed' : 'uncertain';
        error = `Evolution HTTP ${response.status}`;
      } else {
        const data: any = await response.json();
        if (typeof data?.key?.id === 'string' && data.key.id) { status = 'sent'; messageId = data.key.id; }
        else error = 'Evolution sem ID de confirmação';
      }
    } catch { error = 'Envio sem confirmação; verificar Evolution antes de repetir.'; }
    this.db.transaction(() => {
      this.db.prepare('UPDATE whatsapp_delivery SET status=?,message_id=?,error=? WHERE id=?').run(status, messageId, error, deliveryId);
      this.db.prepare('UPDATE conversation_messages SET delivery_status=?,external_message_id=? WHERE id=?').run(status, messageId, deliveryId);
      if (status !== 'sent') this.db.prepare('UPDATE requests SET notice=? WHERE id=?').run(`WhatsApp ${status}: ${error}`, id);
    })();
    return { ok: status === 'sent', status, message_id: messageId };
  }

  async voice(body: any) {
    const message = body?.message;
    if (message && message.type !== 'end-of-call-report') return { ok: true, ignored: 'unsupported-event' };
    const metadata = message?.call?.metadata || body;
    const id = metadata?.request_id, supplierId = metadata?.supplier_id;
    const callId = message?.call?.id || body?.call_id;
    const status = message?.endedReason || body?.status;
    const failed = ['busy', 'no-answer', 'failed', 'customer-busy', 'customer-did-not-answer', 'call-start-error'];
    const ended = ['hangup', 'completed', 'ended', 'customer-ended-call', 'assistant-ended-call', 'silence-timed-out', 'max-duration-reached'];
    if (typeof id !== 'string' || typeof supplierId !== 'string' || typeof callId !== 'string' || !callId || callId.length > 200)
      throw new BadRequestException('Evento de voz requer request_id, supplier_id e call_id.');
    const req = this.getRequest(id);
    if (req.status === 'decidida') return { ok: true, ignored: 'decided' };
    if (![...failed, ...ended].includes(status)) return { ok: true, ignored: 'non-terminal-status' };
    const complete = metadata.quote_completed === true || body?.quote_completed === true || req.quotes.some((q: any) => q.event_id === `voice:${callId}` && q.eligible);
    const call = this.db.transaction(() => {
      this.db.prepare('INSERT OR IGNORE INTO whatsapp_voice_calls VALUES(?,?,?,?)').run(callId, id, supplierId, complete ? 1 : 0);
      const saved = this.db.prepare('SELECT * FROM whatsapp_voice_calls WHERE id=?').get(callId) as any;
      if (saved.request_id !== id || saved.supplier_id !== supplierId) throw new BadRequestException('Chamada já vinculada a outro fornecedor/solicitação.');
      if (complete) this.db.prepare('UPDATE whatsapp_voice_calls SET quote_completed=1 WHERE id=?').run(callId);
      return { ...saved, quote_completed: saved.quote_completed || complete };
    })();
    if (call.quote_completed) return { ok: true, ignored: 'quote-completed' };
    const contact = this.db.prepare('SELECT * FROM whatsapp_contacts WHERE request_id=? AND supplier_id=?').get(id, supplierId) as any;
    if (!contact) {
      this.db.prepare('UPDATE requests SET notice=? WHERE id=?').run('Ligação encerrada sem cotação; fornecedor sem WhatsApp cadastrado.', id);
      return { ok: true, ignored: 'no-whatsapp' };
    }
    const sent = await this.sendWhatsApp(id, contact.number,
      `Olá! Tentamos contato telefônico para cotar ${req.product} (Qtd: ${req.qty}, Destino: ${req.destination}), mas a ligação não completou. Você poderia nos informar o preço unitário, frete, taxas, prazo e estoque por aqui?`, `voice:${callId}`);
    if (sent.ok) this.db.prepare('UPDATE requests SET notice=? WHERE id=?').run('Fallback efetuado: cotação enviada ao fornecedor pelo WhatsApp após falha/encerramento da ligação.', id);
    return { ok: true, fallback: sent };
  }

  async webhook(body: any, secret: string) {
    webhookAuth(secret, process.env.WHATSAPP_WEBHOOK_SECRET || '');
    if (body?.instance !== process.env.WHATSAPP_INSTANCE_NAME || !['messages.upsert', 'MESSAGES_UPSERT'].includes(body?.event)) return { ok: true, ignored: 'unsupported-event' };
    const data = body?.data;
    if (data?.key?.fromMe === true) return { ok: true, ignored: 'from-me' };
    const jid = data?.key?.remoteJid, externalId = data?.key?.id;
    if (typeof jid !== 'string' || !/^[1-9]\d{6,14}@s\.whatsapp\.net$/.test(jid) || typeof externalId !== 'string' || !externalId || externalId.length > 200)
      return { ok: true, ignored: 'unsupported-sender' };
    const text = data?.message?.conversation || data?.message?.extendedTextMessage?.text;
    if (typeof text !== 'string' || !text.trim() || text.length > 16000) return { ok: true, ignored: 'unsupported-message' };
    const number = jid.split('@')[0], updateId = digest(body.instance, number, externalId);
    const previous = this.db.prepare('SELECT status FROM whatsapp_updates WHERE id=?').get(updateId) as any;
    if (previous) return { ok: true, duplicate: true, status: previous.status };
    const parent = data.message?.extendedTextMessage?.contextInfo?.stanzaId;
    let mapping: any = typeof parent === 'string' ? this.db.prepare(`SELECT c.* FROM whatsapp_contacts c JOIN whatsapp_delivery d
      ON d.request_id=c.request_id AND d.number=c.number WHERE c.number=? AND d.message_id=?`).get(number, parent) : null;
    if (!mapping) {
      const open = this.db.prepare(`SELECT c.* FROM whatsapp_contacts c JOIN requests r ON r.id=c.request_id
        WHERE c.number=? AND r.status<>'decidida' AND EXISTS(SELECT 1 FROM whatsapp_delivery d WHERE d.request_id=c.request_id AND d.number=c.number AND d.status IN ('sent','uncertain','sending'))`).all(number) as any[];
      if (open.length !== 1) return { ok: true, ignored: open.length ? 'ambiguous-request' : 'unknown-contact' };
      mapping = open[0];
    }
    if (this.getRequest(mapping.request_id).status === 'decidida') return { ok: true, ignored: 'decided' };
    this.db.transaction(() => {
      this.db.prepare("INSERT INTO whatsapp_updates VALUES(?,?,?,?,?,'pending',0,NULL,NULL,?)").run(updateId, mapping.request_id, number, mapping.supplier_id, text.trim(), now());
      this.db.prepare(`INSERT INTO conversation_messages(id,request_id,chat_id,sender_type,content,channel,external_message_id,created_at)
        VALUES(?,?,?,'SUPPLIER',?,'whatsapp',?,?)`).run(`wa:${updateId}`, mapping.request_id, number, text.trim(), externalId, now());
    })();
    await this.process(updateId);
    return { ok: true, status: (this.db.prepare('SELECT status FROM whatsapp_updates WHERE id=?').get(updateId) as any).status };
  }

  pump() {
    for (const row of this.db.prepare("SELECT id FROM whatsapp_updates WHERE status IN ('pending','ready') AND attempts<3 AND (retry_after IS NULL OR retry_after<=?) ORDER BY rowid LIMIT 10").all(now()) as any[])
      void this.process(row.id).catch(() => {});
  }

  private async process(id: string) {
    const row = this.db.prepare('SELECT rowid,* FROM whatsapp_updates WHERE id=?').get(id) as any;
    if (!row || !['pending', 'ready'].includes(row.status) || row.attempts >= 3) return;
    const lock = `${row.request_id}:${row.number}`;
    if (this.active.has(lock)) return;
    // Preserve supplier turn ordering even while a previous interpretation is waiting for retry.
    if (this.db.prepare("SELECT 1 FROM whatsapp_updates WHERE request_id=? AND number=? AND rowid<? AND status IN ('pending','processing','ready')").get(row.request_id, row.number, row.rowid)) return;
    this.active.add(lock);
    this.db.prepare("UPDATE whatsapp_updates SET status='processing',attempts=attempts+1 WHERE id=?").run(id);
    try {
      const req = this.getRequest(row.request_id);
      if (req.status === 'decidida') { this.db.prepare("UPDATE whatsapp_updates SET status='processed' WHERE id=?").run(id); return; }
      let answer = row.answer;
      if (!answer) {
        const history = (this.db.prepare(`SELECT sender_type,content FROM conversation_messages WHERE request_id=? AND chat_id=? AND channel='whatsapp'
          AND rowid<(SELECT rowid FROM conversation_messages WHERE id=?) ORDER BY rowid DESC LIMIT 12`).all(req.id, row.number, `wa:${id}`) as any[]).reverse();
        const response = await fetch(`${process.env.AGENT_URL || 'http://agents:8000'}/interpret-quote`, {
          method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.INTERNAL_API_TOKEN || ''}` },
          body: JSON.stringify({ request_id: req.id, product: req.product, qty: req.qty, destination: req.destination,
            text: `Contexto recente (termos já informados):\n${history.map(x => `${x.sender_type}: ${x.content}`).join('\n')}\nMensagem atual do fornecedor: ${row.content}` }), signal: AbortSignal.timeout(35000),
        });
        if (!response.ok) throw new Error('Interpretação indisponível');
        const parsed: any = await response.json();
        const prefix = `whatsapp:${digest(row.number)}:`;
        const state = this.db.prepare('SELECT state FROM whatsapp_quote_state WHERE request_id=? AND number=?').get(req.id, row.number) as any;
        const prior = state ? JSON.parse(state.state) : null;
        const contact = this.db.prepare('SELECT name FROM whatsapp_contacts WHERE request_id=? AND supplier_id=?').get(req.id, row.supplier_id) as any;
        const merged: any = { supplier: contact.name, event_id: `${prefix}${id}`, conditions: parsed.conditions || prior?.conditions || '' };
        for (const field of ['unit_cents', 'shipping_cents', 'fees_cents', 'lead_days', 'available_qty']) merged[field] = parsed[field] ?? prior?.[field] ?? null;
        for (const field of ['product', 'destination']) merged[`${field}_confirmed`] = parsed[`${field}_denied`] ? false : parsed[`${field}_confirmed`] === true || !!prior?.[`${field}_confirmed`];
        // Filter parsed.pending against merged facts, so incremental replies only ask for missing fields.
        const fields: [string, string][] = [['unit_cents','preço unitário'], ['shipping_cents','frete'], ['fees_cents','taxas'], ['lead_days','prazo'], ['available_qty','disponibilidade'], ['product_confirmed','confirmação do produto'], ['destination_confirmed','confirmação do CEP']];
        const missing = fields.filter(([key]) => merged[key] == null || merged[key] === false).map(([, label]) => label);
        const pending = Array.isArray(parsed.pending) ? parsed.pending.filter((p: unknown) => typeof p === 'string' && missing.includes(p)) : [];
        const remaining = [...new Set([...pending, ...missing])];
        answer = remaining.length ? `Obrigado! Para completar a cotação, pode me informar ${remaining.join(', ')}?` : 'Obrigado! Sua cotação foi registrada para comparação.';
        this.db.transaction(() => {
          if (merged.unit_cents != null) this.addQuote(req.id, merged);
          this.db.prepare('INSERT INTO whatsapp_quote_state VALUES(?,?,?) ON CONFLICT(request_id,number) DO UPDATE SET state=excluded.state').run(req.id, row.number, JSON.stringify(merged));
          this.db.prepare("UPDATE whatsapp_updates SET answer=?,status='ready' WHERE id=?").run(answer, id);
        })();
      }
      const sent = await this.sendWhatsApp(req.id, row.number, answer, `reply:${id}`);
      this.db.prepare("UPDATE whatsapp_updates SET status=? WHERE id=?").run(sent.ok ? 'processed' : 'exhausted', id);
    } catch {
      const saved = this.db.prepare('SELECT answer FROM whatsapp_updates WHERE id=?').get(id) as any;
      this.db.prepare('UPDATE whatsapp_updates SET status=?,retry_after=? WHERE id=?').run(row.attempts + 1 >= 3 ? 'exhausted' : (saved.answer ? 'ready' : 'pending'), new Date(Date.now() + 10000).toISOString(), id);
      this.db.prepare('UPDATE requests SET notice=? WHERE id=?').run('WhatsApp: processamento pendente; até 3 tentativas automáticas.', row.request_id);
    } finally { this.active.delete(lock); }
  }
}
