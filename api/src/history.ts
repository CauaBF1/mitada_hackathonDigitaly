import { BadRequestException } from '@nestjs/common';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';

const stages = ['recebida', 'pesquisando', 'aguardando', 'comparação', 'decidida'];
const activity = `(SELECT MAX(recorded_at) FROM (
  SELECT r.created_at AS recorded_at
  UNION ALL SELECT created_at FROM quotes WHERE request_id=r.id
  UNION ALL SELECT created_at FROM conversation_messages WHERE request_id=r.id
))`;

export class HistoryService {
  constructor(private db: Database.Database, private getRequest: (id: string) => any) {
    db.exec(`CREATE INDEX IF NOT EXISTS history_requests_created ON requests(created_at,id);
      CREATE INDEX IF NOT EXISTS history_requests_status_created ON requests(status,created_at);
      CREATE INDEX IF NOT EXISTS history_quotes_request_created ON quotes(request_id,created_at);
      CREATE INDEX IF NOT EXISTS history_messages_request_created ON conversation_messages(request_id,created_at);`);
  }

  list(query: Record<string, unknown>) {
    const integer = (value: unknown, fallback: number, max: number) => {
      if (value === undefined) return fallback;
      if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > max)
        throw new BadRequestException('Paginação inválida.');
      return Number(value);
    };
    const page = integer(query.page, 1, 1000000), pageSize = integer(query.page_size, 20, 100);
    const where: string[] = [], args: (string | number)[] = [];
    if (query.q !== undefined) {
      if (typeof query.q !== 'string' || query.q.length > 200) throw new BadRequestException('Busca inválida.');
      where.push("r.product LIKE ? ESCAPE '\\'");
      args.push(`%${query.q.trim().replace(/[\\%_]/g, '\\$&')}%`);
    }
    if (query.status !== undefined && query.status !== '') {
      if (typeof query.status !== 'string' || !stages.includes(query.status)) throw new BadRequestException('Estágio inválido.');
      where.push('r.status=?'); args.push(query.status);
    }
    for (const [key, operator] of [['created_from', '>='], ['created_before', '<']]) {
      if (query[key] !== undefined) {
        const value = query[key];
        if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value)
          throw new BadRequestException('Período inválido; informe uma data ISO UTC.');
        where.push(`r.created_at${operator}?`); args.push(value);
      }
    }
    if (query.created_from && query.created_before && String(query.created_from) >= String(query.created_before)) throw new BadRequestException('O início do período deve anteceder o final.');
    if (query.sort !== undefined && (typeof query.sort !== 'string' || !['newest','oldest'].includes(query.sort))) throw new BadRequestException('Ordenação inválida.');
    const order = query.sort === 'oldest' ? 'ASC' : 'DESC';
    const filter = where.length ? `WHERE ${where.join(' AND ')}` : '';
    return this.db.transaction(() => {
      const total = (this.db.prepare('SELECT count(*) AS count FROM requests').get() as any).count;
      const filtered = (this.db.prepare(`SELECT count(*) AS count FROM requests r ${filter}`).get(...args) as any).count;
      const pages = Math.ceil(filtered / pageSize), currentPage = Math.min(page, Math.max(1, pages));
      const rows = this.db.prepare(`SELECT r.id,${activity} AS last_activity_at FROM requests r ${filter} ORDER BY r.created_at ${order},r.id ${order} LIMIT ? OFFSET ?`)
        .all(...args, pageSize, (currentPage - 1) * pageSize) as any[];
      const items = rows.map(row => {
        const req = this.getRequest(row.id), selected = req.quotes.find((q: any) => q.id === req.decision);
        return { id: req.id, product: req.product, qty: req.qty, destination: req.destination, status: req.status,
          created_at: req.created_at, last_activity_at: row.last_activity_at, quote_count: req.quotes.length,
          eligible_quote_count: req.quotes.filter((q: any) => q.eligible).length,
          partial_quote_count: req.quotes.filter((q: any) => !q.eligible).length,
          selected_supplier: selected?.supplier ?? null, selected_tco_cents: selected?.tco_cents ?? null };
      });
      return { items, total, filtered_total: filtered, page: currentPage, page_size: pageSize, pages };
    })();
  }

  detail(id: string) {
    return this.db.transaction(() => {
      const req = this.getRequest(id);
      const quotes = req.quotes.map((q: any) => ({
        id: q.id, supplier: q.supplier, unit_cents: q.unit_cents, shipping_cents: q.shipping_cents, fees_cents: q.fees_cents,
        lead_days: q.lead_days, available_qty: q.available_qty, conditions: q.conditions, source_url: q.source_url,
        product_confirmed: q.product_confirmed, destination_confirmed: q.destination_confirmed,
        created_at: q.created_at, tco_cents: q.tco_cents, eligible: q.eligible, eligibility_reasons: q.eligibility_reasons,
        selected: req.decision === q.id,
        channel: String(q.event_id).startsWith('whatsapp:') ? 'whatsapp' : String(q.event_id).startsWith('telegram:') ? 'telegram' : String(q.event_id).startsWith('voice:') ? 'voice' : null,
      }));
      const groups = new Map<string, any>();
      const messages = this.db.prepare(`SELECT id,chat_id,sender_type,content,delivery_status,channel,created_at FROM conversation_messages WHERE request_id=? ORDER BY created_at,rowid`).all(id) as any[];
      for (const message of messages) {
        const channel = message.channel || 'telegram';
        const key = createHash('sha256').update(JSON.stringify([id,channel,message.chat_id])).digest('hex').slice(0,24);
        if (!groups.has(key)) {
          const contact = channel === 'whatsapp' ? this.db.prepare('SELECT name FROM whatsapp_contacts WHERE request_id=? AND number=?').get(id, message.chat_id) as any : null;
          groups.set(key, { id: key, channel, contact_name: contact?.name || `Contato ${channel === 'telegram' ? 'Telegram' : 'WhatsApp'} ${groups.size + 1}`, messages: [] });
        }
        groups.get(key).messages.push({ id: message.id, sender_type: message.sender_type, content: message.content,
          delivery_status: message.delivery_status, channel, created_at: message.created_at });
      }
      const timeline = [
        { id: `created:${id}`, kind: 'created', created_at: req.created_at, label: 'Solicitação criada', description: `${req.qty} unidade(s) · destino ${req.destination}` },
        ...quotes.map((q: any) => ({ id: `quote:${q.id}`, kind: 'quote', created_at: q.created_at, label: 'Proposta registrada', description: q.supplier })),
        ...Array.from(groups.values()).flatMap(group => group.messages.map((m: any) => ({ id: `message:${m.id}`, kind: 'message', created_at: m.created_at,
          label: m.sender_type === 'AI' ? 'Mensagem da Nexo registrada' : 'Mensagem do fornecedor recebida', description: `${group.contact_name} · ${group.channel}` }))),
      ].sort((a,b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
      return { id: req.id, product: req.product, specs: req.specs, qty: req.qty, destination: req.destination,
        status: req.status, notice: req.notice, created_at: req.created_at, last_activity_at: timeline.at(-1)?.created_at ?? req.created_at,
        decision_quote_id: req.decision, decision_at: null, quotes, conversations: Array.from(groups.values()), timeline,
        timeline_limitations: 'Datas de mudanças de estágio e da decisão não foram registradas. A linha do tempo reúne apenas criação, propostas e mensagens com data persistida.' };
    })();
  }
}
