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
  private deadlines = new Map<string, ReturnType<typeof setTimeout>>();
  constructor(private db: Database.Database, private getRequest: (id: string) => any,
    private addQuote: (id: string, quote: any) => any,
    private sendTelegram: (deliveryId: string, requestId: string, chat: string, text: string) => Promise<boolean>) {
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
      quote_completed INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS whatsapp_contact_flow(
      request_id TEXT PRIMARY KEY REFERENCES requests(id), supplier_id TEXT NOT NULL,
      status TEXT NOT NULL, call_id TEXT, error TEXT, next_check_at TEXT, request_version INTEGER);`);
    if (!(db.prepare('PRAGMA table_info(whatsapp_contact_flow)').all() as any[]).some(column => column.name === 'request_version'))
      db.exec('ALTER TABLE whatsapp_contact_flow ADD COLUMN request_version INTEGER');
    // A call interrupted during creation may already exist at the provider. Never redial it.
    db.prepare("UPDATE whatsapp_contact_flow SET status='attention',error='Criação de chamada interrompida; não repetida.' WHERE status='starting'").run();
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

  registerTestSupplier(id: string) {
    const number = process.env.WHATSAPP_TEST_SUPPLIER_NUMBER?.trim();
    if (number) this.register(id, { supplier_id: 'teste-whatsapp', name: 'Fornecedor de teste', number });
  }

  registerConfiguredSupplier(id: string) {
    const number = process.env.WHATSAPP_SUPPLIER_NUMBER?.trim();
    if (number) this.register(id, { supplier_id: 'configured-whatsapp', name: 'Fornecedor configurado', number });
  }

  /** Exposes channel-scoped partial terms without merging them into Telegram drafts. */
  pending(id: string): any[] {
    return (this.db.prepare(`SELECT c.supplier_id,c.name AS supplier_name,c.number,s.state,s.rowid,
      (SELECT MAX(u.created_at) FROM whatsapp_updates u WHERE u.request_id=s.request_id AND u.number=s.number) AS updated_at
      FROM whatsapp_quote_state s JOIN whatsapp_contacts c ON c.request_id=s.request_id AND c.number=s.number
      WHERE s.request_id=? ORDER BY s.rowid`).all(id) as any[]).map(row => {
      let terms: any = {}; try { terms = JSON.parse(row.state); } catch { }
      const fields: [string, string][] = [['unit_cents','unit_cents'],['shipping_cents','shipping_cents'],['fees_cents','fees_cents'],
        ['lead_days','lead_days'],['available_qty','available_qty'],['product_confirmed','product_confirmed'],['destination_confirmed','destination_confirmed']];
      return { supplier_id: `whatsapp:${row.supplier_id}`, supplier_name: row.supplier_name, number: row.number, terms,
        missing_fields: fields.filter(([key]) => terms[key] == null || terms[key] === false).map(([, key]) => key), updated_at: row.updated_at };
    });
  }

  startContact(id: string, supplierId?: string) {
    const req = this.getRequest(id);
    if (['decidida', 'concluida'].includes(req.status)) return { ok: false, status: 'closed' };
    const contacts = this.db.prepare('SELECT supplier_id FROM whatsapp_contacts WHERE request_id=? ORDER BY rowid').all(id) as any[];
    if (!supplierId && contacts.length > 1) return { ok: false, status: 'ambiguous-whatsapp-contact' };
    const contact = supplierId ? contacts.find(row => row.supplier_id === supplierId) : contacts[0];
    if (!contact) return { ok: false, status: 'no-whatsapp-contact' };
    const priorFlow = this.db.prepare('SELECT supplier_id,status FROM whatsapp_contact_flow WHERE request_id=?').get(id) as any;
    if (priorFlow && priorFlow.supplier_id !== contact.supplier_id) return { ok: false, status: 'contact-already-bound', supplier_id: priorFlow.supplier_id };
    this.db.prepare(`INSERT OR IGNORE INTO whatsapp_contact_flow(request_id,supplier_id,status,request_version)
      VALUES(?,?,'ready',?)`).run(id, contact.supplier_id, req.version);
    const flow = this.db.prepare('SELECT status FROM whatsapp_contact_flow WHERE request_id=?').get(id) as any;
    this.pump();
    const current = this.db.prepare('SELECT status FROM whatsapp_contact_flow WHERE request_id=?').get(id) as any;
    return { ok: true, status: current?.status || flow?.status || 'queued', supplier_id: contact.supplier_id };
  }

  cancelContact(id: string) {
    const timer = this.deadlines.get(id); if (timer) clearTimeout(timer); this.deadlines.delete(id);
    this.db.prepare("UPDATE whatsapp_contact_flow SET status='cancelled',next_check_at=NULL,error='Contato cancelado.' WHERE request_id=? AND status IN ('ready','wa_waiting','telegram_fallback')").run(id);
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
    // Baileys can identify private chats by LID and provide the phone separately.
    // Only use the alternate phone for LID chats; never turn groups into contacts.
    const remoteJid = data?.key?.remoteJid;
    const jid = typeof remoteJid === 'string' && /^\d+@lid$/.test(remoteJid)
      ? data?.key?.remoteJidAlt : remoteJid;
    const externalId = data?.key?.id;
    if (typeof jid !== 'string' || !/^[1-9]\d{6,14}@s\.whatsapp\.net$/.test(jid) || typeof externalId !== 'string' || !externalId || externalId.length > 200)
      return { ok: true, ignored: 'unsupported-sender' };
    const text = data?.message?.conversation || data?.message?.extendedTextMessage?.text;
    if (typeof text !== 'string' || !text.trim() || text.length > 16000) return { ok: true, ignored: 'unsupported-message' };
    const number = jid.split('@')[0], updateId = digest(body.instance, number, externalId);
    const previous = this.db.prepare('SELECT status FROM whatsapp_updates WHERE id=?').get(updateId) as any;
    if (previous) return { ok: true, duplicate: true, status: previous.status };
    const parent = data.message?.extendedTextMessage?.contextInfo?.stanzaId ?? data.contextInfo?.stanzaId;
    let mapping: any = typeof parent === 'string' ? this.db.prepare(`SELECT c.* FROM whatsapp_contacts c JOIN whatsapp_delivery d
      ON d.request_id=c.request_id AND d.number=c.number WHERE c.number=? AND d.message_id=?`).get(number, parent) : null;
    if (typeof parent === 'string' && !mapping) return { ok: true, ignored: 'unknown-reply' };
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
      // A recognized supplier reply ends the 30-second fallback window, even if parsing retries.
      this.db.prepare("UPDATE whatsapp_contact_flow SET status='done',error=NULL,next_check_at=NULL WHERE request_id=? AND supplier_id=? AND status IN ('ready','wa_waiting')")
        .run(mapping.request_id, mapping.supplier_id);
    })();
    await this.process(updateId);
    return { ok: true, status: (this.db.prepare('SELECT status FROM whatsapp_updates WHERE id=?').get(updateId) as any)?.status || 'deleted' };
  }

  pump() {
    const waiting = this.db.prepare("SELECT * FROM whatsapp_contact_flow WHERE status='wa_waiting' AND next_check_at IS NOT NULL").all() as any[];
    for (const row of waiting) {
      if (this.deadlines.has(row.request_id)) continue;
      const delay = Math.max(0, Date.parse(row.next_check_at) - Date.now());
      const timer = setTimeout(() => {
        this.deadlines.delete(row.request_id);
        const current = this.db.prepare("SELECT * FROM whatsapp_contact_flow WHERE request_id=? AND status='wa_waiting'").get(row.request_id) as any;
        if (current) void this.advanceContact(current).catch(() => {});
      }, delay);
      timer.unref(); this.deadlines.set(row.request_id, timer);
    }
    for (const row of this.db.prepare("SELECT * FROM whatsapp_contact_flow WHERE status IN ('ready','wa_waiting','telegram_fallback','waiting','fallback') AND (next_check_at IS NULL OR next_check_at<=?) LIMIT 5").all(now()) as any[])
      void this.advanceContact(row).catch(() => {});
    for (const row of this.db.prepare("SELECT id FROM whatsapp_updates WHERE status IN ('pending','ready') AND attempts<3 AND (retry_after IS NULL OR retry_after<=?) ORDER BY rowid LIMIT 10").all(now()) as any[])
      void this.process(row.id).catch(() => {});
  }

  private async advanceContact(row: any) {
    const lock = `contact:${row.request_id}`;
    if (this.active.has(lock)) return;
    this.active.add(lock);
    const exists = () => !!this.db.prepare('SELECT 1 FROM whatsapp_contact_flow WHERE request_id=?').get(row.request_id);
    const set = (status: string, error: string | null = null, callId: string | null = row.call_id) => {
      const changed = this.db.prepare('UPDATE whatsapp_contact_flow SET status=?,error=?,call_id=?,next_check_at=? WHERE request_id=? AND status=?')
        .run(status, error, callId, new Date(Date.now() + 15000).toISOString(), row.request_id, row.status);
      if (!changed.changes) return false;
      if (status !== 'wa_waiting') { const timer = this.deadlines.get(row.request_id); if (timer) clearTimeout(timer); this.deadlines.delete(row.request_id); }
      row.status = status; row.call_id = callId; row.error = error;
      return true;
    };
    try {
      const req = this.getRequest(row.request_id);
      if (['decidida','concluida'].includes(req.status)) { set('done'); return; }
      // Continue polling only calls that were already in progress before this WhatsApp-first flow.
      if (row.status === 'waiting') {
        if (!row.call_id) { set('attention', 'Chamada antiga sem identificador; não será repetida.'); return; }
        const base = (process.env.AGENT_URL || 'http://agents:8000').replace(/\/$/, '');
        const response = await fetch(`${base}/voice/call/${encodeURIComponent(row.call_id)}`, {
          headers: { authorization: `Bearer ${process.env.INTERNAL_API_TOKEN || ''}` }, signal: AbortSignal.timeout(15000) });
        if (!exists()) return;
        if (!response.ok) throw new Error('Estado da chamada antiga indisponível');
        const call: any = await response.json();
        if (call.call_id !== row.call_id || call.request_id !== req.id || call.supplier_id !== row.supplier_id) throw new Error('Chamada antiga não corresponde à solicitação');
        if (!['ended','failed'].includes(call.status)) {
          this.db.prepare("UPDATE whatsapp_contact_flow SET next_check_at=? WHERE request_id=? AND status='waiting'").run(new Date(Date.now() + 15000).toISOString(), req.id);
          return;
        }
        if (!set('fallback', call.ended_reason || 'Chamada antiga encerrada sem cotação registrada.')) return;
        row.status = 'fallback';
      }
      if (row.status === 'fallback') {
        if (!row.call_id && !/^Falha ao iniciar ligação: HTTP 4\d\d\./.test(row.error || '')) {
          set('attention', 'Estado legado da chamada incerto; nenhum novo contato automático foi iniciado.'); return;
        }
        const legacy = await this.voice({ request_id: req.id, supplier_id: row.supplier_id,
          call_id: row.call_id || `legacy-rejected:${req.id}`, status: 'ended', quote_completed: false });
        if (exists()) set(legacy.fallback?.ok || legacy.ignored ? 'done' : 'attention', row.error || null);
        return;
      }
      if (row.status === 'ready') {
        const contact = this.db.prepare('SELECT * FROM whatsapp_contacts WHERE request_id=? AND supplier_id=?').get(req.id, row.supplier_id) as any;
        if (!contact) { set('done', 'Fornecedor não cadastrado.'); return; }
        if (!process.env.WHATSAPP_API_URL || !process.env.WHATSAPP_API_KEY || !process.env.WHATSAPP_INSTANCE_NAME) {
          set('attention', 'Contato WhatsApp cadastrado, mas a Evolution não está configurada. Nenhuma mensagem foi enviada.');
          this.db.prepare('UPDATE requests SET notice=? WHERE id=?').run('Contato WhatsApp indisponível por falta de configuração; nenhum envio foi presumido.', req.id);
          return;
        }
        const message = `Olá! Você poderia cotar ${req.product} (${req.qty} unidades) para entrega em ${req.destination}? Informe preço unitário, frete, taxas, prazo, disponibilidade e condições.`;
        const sent = await this.sendWhatsApp(req.id, contact.number, message, `contact:${req.id}:${contact.supplier_id}`);
        if (!exists()) return;
        const latest = this.getRequest(req.id);
        const currentFlow = this.db.prepare('SELECT supplier_id,status,request_version FROM whatsapp_contact_flow WHERE request_id=?').get(req.id) as any;
        if (!currentFlow || currentFlow.status !== 'ready' || currentFlow.supplier_id !== row.supplier_id) return;
        if (['decidida','concluida'].includes(latest.status) ||
          (row.request_version != null && latest.version !== row.request_version)) {
          this.db.prepare("UPDATE whatsapp_contact_flow SET status='attention',next_check_at=NULL,error='Solicitação mudou durante o envio; fallback interrompido.' WHERE request_id=? AND status='ready' AND supplier_id=? AND request_version IS ?")
            .run(req.id, row.supplier_id, row.request_version ?? null);
          return;
        }
        const rawTimeout = Number(process.env.WHATSAPP_TELEGRAM_FALLBACK_SECONDS || 30);
        const timeoutMs = (Number.isInteger(rawTimeout) ? Math.min(3600, Math.max(1, rawTimeout)) : 30) * 1000;
        const error = sent.status === 'failed' ? 'Evolution rejeitou o envio WhatsApp.' : sent.status === 'uncertain' ? 'Envio WhatsApp sem confirmação; não será repetido.' : null;
        const transitioned = this.db.prepare(`UPDATE whatsapp_contact_flow SET status='wa_waiting',error=?,next_check_at=?
          WHERE request_id=? AND supplier_id=? AND status='ready' AND request_version IS ?
          AND EXISTS(SELECT 1 FROM requests WHERE id=? AND status NOT IN ('decidida','concluida') AND version=?)`)
          .run(error, new Date(Date.now() + timeoutMs).toISOString(), req.id, row.supplier_id, row.request_version ?? null,
            req.id, row.request_version ?? latest.version);
        if (!transitioned.changes) return;
        const seconds = timeoutMs / 1000;
        const notice = sent.status === 'sent' ? `Mensagem aceita pela Evolution; aguardando resposta por ${seconds} segundos antes do fallback Telegram.`
          : sent.status === 'failed' ? `Evolution rejeitou a mensagem WhatsApp; fallback Telegram agendado para ${seconds} segundos.`
          : `Envio WhatsApp sem confirmação; não será repetido. Fallback Telegram agendado para ${seconds} segundos.`;
        this.db.prepare('UPDATE requests SET notice=? WHERE id=?').run(notice, req.id);
        row.status = 'wa_waiting';
        this.pump();
        return;
      }
      if (row.status === 'wa_waiting') {
        const received = this.db.prepare("SELECT 1 FROM whatsapp_updates WHERE request_id=? AND supplier_id=? LIMIT 1").get(req.id, row.supplier_id);
        if (received) { set('done'); return; }
        const delivery = this.db.prepare('SELECT status FROM whatsapp_delivery WHERE request_id=? AND number=? ORDER BY created_at DESC LIMIT 1').get(req.id,
          (this.db.prepare('SELECT number FROM whatsapp_contacts WHERE request_id=? AND supplier_id=?').get(req.id, row.supplier_id) as any)?.number) as any;
        if (delivery?.status === 'failed') { set('telegram_fallback', 'WhatsApp não foi entregue.'); row.status = 'telegram_fallback'; }
        else {
          // Keep the original persisted deadline; no timer is reset on process restart.
          set('telegram_fallback'); row.status = 'telegram_fallback';
        }
      }
      if (row.status === 'telegram_fallback') {
        const allowed = (process.env.TELEGRAM_ALLOWED_CHAT_IDS || '').split(',').map(x => x.trim()).filter(Boolean);
        const known = this.db.prepare('SELECT DISTINCT chat_id FROM telegram_outbound WHERE request_id=?').all(req.id).map((x: any) => String(x.chat_id));
        const chats = known.length === 1 ? known : known.length > 1 ? [] : allowed.length === 1 ? allowed : [];
        if (!process.env.TELEGRAM_BOT_TOKEN || !chats.length) {
          set('attention', 'Fallback Telegram exige um chat específico previamente vinculado ou exatamente um chat autorizado.');
          return;
        }
        const chat = chats[0];
        const deliveryId = `wa-fallback:${req.id}`;
        const prior = this.db.prepare('SELECT status FROM telegram_delivery WHERE id=?').get(deliveryId) as any;
        if (prior?.status === 'sent' || prior?.status === 'sending' || prior?.status === 'uncertain') { set(prior.status === 'sent' ? 'done' : 'attention', prior.status === 'sent' ? null : 'Entrega Telegram incerta; não repetida.'); return; }
        this.db.prepare("INSERT OR IGNORE INTO telegram_delivery(id,request_id,chat_id,status,error,created_at,message_text) VALUES(?,?,?,'sending',NULL,?,?)")
          .run(deliveryId, req.id, chat, now(), `Olá! Você poderia cotar ${req.product} (${req.qty} unidades) para entrega em ${req.destination}? Informe preço unitário, frete, taxas, prazo, disponibilidade e condições.`);
        const message = `Olá! Você poderia cotar ${req.product} (${req.qty} unidades) para entrega em ${req.destination}? Informe preço unitário, frete, taxas, prazo, disponibilidade e condições.`;
        const result = await this.sendTelegram(deliveryId, req.id, chat, message);
        if (exists()) set(result ? 'done' : 'attention', result ? null : 'Fallback Telegram sem confirmação; não será repetido se a entrega for incerta.');
      }
    } catch {
      if (exists()) {
        this.db.prepare('UPDATE whatsapp_contact_flow SET next_check_at=? WHERE request_id=?').run(new Date(Date.now() + 15000).toISOString(), row.request_id);
        this.db.prepare('UPDATE requests SET notice=? WHERE id=?').run('Contato automático pendente; verificando o estado sem repetir a ligação.', row.request_id);
      }
    } finally { this.active.delete(lock); }
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
        // Deletion can happen while interpretation is in flight. Never recreate auxiliary state.
        this.getRequest(req.id);
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
      if (!saved) return;
      this.db.prepare('UPDATE whatsapp_updates SET status=?,retry_after=? WHERE id=?').run(row.attempts + 1 >= 3 ? 'exhausted' : (saved.answer ? 'ready' : 'pending'), new Date(Date.now() + 10000).toISOString(), id);
      this.db.prepare('UPDATE requests SET notice=? WHERE id=?').run('WhatsApp: processamento pendente; até 3 tentativas automáticas.', row.request_id);
    } finally { this.active.delete(lock); }
  }
}
