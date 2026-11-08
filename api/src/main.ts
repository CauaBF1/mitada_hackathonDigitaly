import 'reflect-metadata';
import { HistoryService } from './history';
import { WhatsAppService, webhookAuth } from './whatsapp';
import { BadRequestException, Body, Controller, Delete, Get, Headers, HttpCode, HttpException, Injectable, NotFoundException, Param, Post, Query, UnauthorizedException, ServiceUnavailableException, ConflictException, Module, OnModuleInit, Inject } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import Database from 'better-sqlite3';
import { randomBytes, randomUUID, scryptSync, createHmac, timingSafeEqual, createHash } from 'node:crypto';
import { dispatchPurchaseOutbox } from './purchase-delivery';
import { buildJevRecommendationPayload, createRecommendationSummary, hashRecommendationInputs, RecommendationOffer, DEFAULT_SUPPLIER_MAX_PREMIUM_PERCENT } from './purchase-recommendation';

const db = new Database(process.env.DATABASE_PATH || './business.sqlite');
db.pragma('journal_mode = WAL');
db.exec(`CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, password_hash TEXT, google_id TEXT, avatar_url TEXT, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS app_settings(key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS requests(id TEXT PRIMARY KEY, product TEXT NOT NULL, specs TEXT NOT NULL, qty INTEGER NOT NULL, destination TEXT NOT NULL, status TEXT NOT NULL, decision TEXT, version INTEGER NOT NULL DEFAULT 1, execution_version INTEGER NOT NULL DEFAULT 0, agent_analysis TEXT, notice TEXT, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS quotes(id TEXT PRIMARY KEY, request_id TEXT NOT NULL REFERENCES requests(id), event_id TEXT NOT NULL, supplier TEXT NOT NULL, unit_cents INTEGER NOT NULL, shipping_cents INTEGER, fees_cents INTEGER, lead_days INTEGER, available_qty INTEGER, conditions TEXT, source_url TEXT, product_confirmed INTEGER NOT NULL DEFAULT 0, destination_confirmed INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, UNIQUE(request_id,event_id));
CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY, request_id TEXT NOT NULL, status TEXT NOT NULL, payload TEXT, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS telegram_outbound(chat_id TEXT NOT NULL, message_id INTEGER NOT NULL, request_id TEXT NOT NULL, PRIMARY KEY(chat_id,message_id));
CREATE TABLE IF NOT EXISTS telegram_delivery(id TEXT PRIMARY KEY,request_id TEXT NOT NULL,chat_id TEXT NOT NULL,status TEXT NOT NULL,error TEXT,created_at TEXT NOT NULL,message_text TEXT);
CREATE TABLE IF NOT EXISTS telegram_updates(update_id INTEGER PRIMARY KEY, received_at TEXT NOT NULL,raw_update TEXT,status TEXT NOT NULL DEFAULT 'received',attempts INTEGER NOT NULL DEFAULT 0,retry_after TEXT,error TEXT);
CREATE TABLE IF NOT EXISTS conversation_messages(id TEXT PRIMARY KEY,request_id TEXT NOT NULL REFERENCES requests(id),chat_id TEXT,sender_type TEXT NOT NULL CHECK(sender_type IN ('AI','SUPPLIER')),content TEXT NOT NULL,delivery_status TEXT NOT NULL DEFAULT 'received',telegram_message_id INTEGER,update_id INTEGER,created_at TEXT NOT NULL,UNIQUE(update_id));
CREATE TABLE IF NOT EXISTS contact_idempotency(request_id TEXT NOT NULL,idempotency_key TEXT NOT NULL,result TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(request_id,idempotency_key));`);
db.exec(`CREATE TABLE IF NOT EXISTS purchase_simulations(id TEXT PRIMARY KEY,request_id TEXT NOT NULL REFERENCES requests(id),quote_id TEXT NOT NULL REFERENCES quotes(id),snapshot TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('awaiting_supplier','review_required','confirmed','rejected','cancelled')),created_at TEXT NOT NULL,idempotency_key TEXT NOT NULL,UNIQUE(request_id,idempotency_key));
CREATE TABLE IF NOT EXISTS purchase_outbox(id TEXT PRIMARY KEY,simulation_id TEXT NOT NULL UNIQUE REFERENCES purchase_simulations(id),request_id TEXT NOT NULL,quote_id TEXT NOT NULL,chat_id TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'queued',created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS reputation_cache(request_id TEXT PRIMARY KEY,refreshed_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS purchase_recommendation_reviews(review_id TEXT PRIMARY KEY,request_id TEXT NOT NULL REFERENCES requests(id),version INTEGER NOT NULL,offer_hash TEXT NOT NULL,factor REAL NOT NULL,request_payload TEXT NOT NULL,result TEXT NOT NULL,approved INTEGER,created_at TEXT NOT NULL,approved_at TEXT);
CREATE TABLE IF NOT EXISTS conversation_drafts(request_id TEXT NOT NULL REFERENCES requests(id),chat_id TEXT NOT NULL,terms TEXT NOT NULL,missing_fields TEXT NOT NULL,validation_errors TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1,updated_at TEXT NOT NULL,PRIMARY KEY(request_id,chat_id));`);
ensureColumn('telegram_delivery','message_text','TEXT');ensureColumn('telegram_updates','raw_update','TEXT');ensureColumn('telegram_updates','status',"TEXT NOT NULL DEFAULT 'received'");ensureColumn('telegram_updates','attempts','INTEGER NOT NULL DEFAULT 0');ensureColumn('telegram_updates','retry_after','TEXT');ensureColumn('telegram_updates','error','TEXT');
function ensureColumn(table:string,column:string,definition:string){const columns=db.prepare(`PRAGMA table_info(${table})`).all() as any[];if(!columns.some(row=>row.name===column))db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);}
ensureColumn('requests','execution_version','INTEGER NOT NULL DEFAULT 0');ensureColumn('requests','agent_analysis','TEXT');ensureColumn('requests','notice','TEXT');ensureColumn('quotes','source_url','TEXT');ensureColumn('quotes','product_confirmed','INTEGER NOT NULL DEFAULT 0');ensureColumn('quotes','destination_confirmed','INTEGER NOT NULL DEFAULT 0');
ensureColumn('quotes','valid_until','TEXT');ensureColumn('quotes','payment_terms','TEXT');
ensureColumn('requests','quote_completion_state',"TEXT NOT NULL DEFAULT 'coletando'");ensureColumn('requests','quote_terms_snapshot','TEXT');ensureColumn('requests','quote_final_message_id','TEXT');
ensureColumn('requests','completed_quote_id','TEXT');
ensureColumn('requests','preferred_market_quote_id','TEXT');ensureColumn('requests','preferred_market_at','TEXT');
ensureColumn('quotes','supplier_chat_id','TEXT');
ensureColumn('telegram_delivery','source_update_id','INTEGER');ensureColumn('telegram_delivery','telegram_message_id','INTEGER');ensureColumn('telegram_delivery','attempts','INTEGER NOT NULL DEFAULT 0');ensureColumn('telegram_delivery','next_attempt_at','TEXT');
db.exec(`DROP INDEX IF EXISTS one_active_purchase_per_request;
CREATE UNIQUE INDEX one_active_purchase_per_request ON purchase_simulations(request_id) WHERE status IN ('awaiting_supplier','confirmed');
CREATE UNIQUE INDEX IF NOT EXISTS one_delivery_per_telegram_update ON telegram_delivery(source_update_id) WHERE source_update_id IS NOT NULL;
UPDATE quotes SET supplier_chat_id=(SELECT CAST(json_extract(u.raw_update,'$.message.chat.id') AS TEXT) FROM telegram_updates u WHERE u.update_id=CAST(substr(quotes.event_id,9) AS INTEGER)) WHERE supplier_chat_id IS NULL AND event_id GLOB 'telegram:*';`);
const outboundInfo=db.prepare('PRAGMA table_info(telegram_outbound)').all() as any[];if(!outboundInfo.some(row=>row.name==='chat_id'&&row.pk===1)){db.exec(`ALTER TABLE telegram_outbound RENAME TO telegram_outbound_legacy;CREATE TABLE telegram_outbound(chat_id TEXT NOT NULL,message_id INTEGER NOT NULL,request_id TEXT NOT NULL,PRIMARY KEY(chat_id,message_id));INSERT OR IGNORE INTO telegram_outbound(chat_id,message_id,request_id) SELECT chat_id,message_id,request_id FROM telegram_outbound_legacy;DROP TABLE telegram_outbound_legacy;`);}
function centsFromText(value:string){const raw=value.trim().replace(/^R\$\s*/i,'');if(!/^(?:\d{1,3}(?:\.\d{3})+|\d+)(?:[,.]\d{1,2})?$/.test(raw))return Number.NaN;const normalized=raw.includes(',')?raw.replace(/\./g,'').replace(',','.'):raw;const [whole,fraction='']=normalized.split('.');const cents=Number(whole)*100+Number((fraction+'00').slice(0,2));return Number.isSafeInteger(cents)?cents:Number.NaN;}

const jwtSecret = () => process.env.JWT_SECRET || 'nexo-dev-jwt-secret-change-in-production';
function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}
function verifyPassword(password: string, stored: string): boolean {
  const [salt, keyHex] = stored.split(':');
  if (!salt || !keyHex) return false;
  const keyBuf = Buffer.from(keyHex, 'hex');
  const derived = scryptSync(password, salt, 64);
  return keyBuf.length === derived.length && timingSafeEqual(keyBuf, derived);
}
function signJwt(payload: Record<string, any>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const body = Buffer.from(JSON.stringify({ ...payload, iat: now, exp: now + 60 * 60 * 24 * 7 })).toString('base64url');
  const sig = createHmac('sha256', jwtSecret()).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${sig}`;
}
function verifyJwt(token: string): Record<string, any> {
  const parts = token.split('.');
  if (parts.length !== 3) throw new UnauthorizedException('Token de sessão inválido.');
  const [header, body, sig] = parts;
  const expected = createHmac('sha256', jwtSecret()).update(`${header}.${body}`).digest('base64url');
  if (sig.length !== expected.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
    throw new UnauthorizedException('Assinatura do token inválida.');
  }
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) {
      throw new UnauthorizedException('Sessão expirada. Faça login novamente.');
    }
    return payload;
  } catch (err) {
    if (err instanceof UnauthorizedException) throw err;
    throw new UnauthorizedException('Token malformado.');
  }
}

@Injectable() class Business implements OnModuleInit {
  readonly whatsapp: WhatsAppService = new WhatsAppService(db, id => this.get(id), (id, q) => this.addQuote(id, q),
    (deliveryId, requestId, chat, text) => this.sendTelegram(deliveryId, requestId, chat, text));
  readonly history = new HistoryService(db, id => this.get(id));
  private turnQueues=new Map<string,Promise<any>>();
  private activeUpdates=new Set<number>();
  private sanitizeError(err:any):string{
    const raw=err instanceof Error?`${err.name}: ${err.message}`:String(err||'erro desconhecido');
    return raw.replace(/(?:tvly-|gsk_|AIza)[A-Za-z0-9_-]+/g,'[REDACTED]').replace(/bot[0-9]+:[A-Za-z0-9_-]+/g,'bot[REDACTED]').replace(/Bearer\s+[A-Za-z0-9._-]+/gi,'Bearer [REDACTED]').slice(0,280);
  }
  private isPendingPlaceholder(text:string|null|undefined):boolean{
    if(!text)return false;
    const s=text.trim();
    return s==='Sua mensagem foi recebida e está com processamento pendente.'
      ||s==='Não consegui processar esta mensagem agora; ela continua pendente para nova tentativa.'
      ||s==='Sua mensagem continua pendente enquanto atualizo a conversa.';
  }
  private withTurnLock<T>(key:string,fn:()=>Promise<T>):Promise<T>{
    const prior=this.turnQueues.get(key)||Promise.resolve();
    // Network operations own their abort deadlines. A timer around the promise
    // cannot cancel its work and must never release this lock early.
    const next=prior.catch(()=>{}).then(fn);
    this.turnQueues.set(key,next);
    void next.finally(()=>{if(this.turnQueues.get(key)===next)this.turnQueues.delete(key);}).catch(()=>{});
    return next;
  }
  private markUpdateExhausted(updateId:number,reason:string){
    const errText=this.sanitizeError(reason);
    db.prepare("UPDATE telegram_updates SET status='exhausted',retry_after=NULL,error=COALESCE(?,error) WHERE update_id=?").run(errText,updateId);
    const msgRow=db.prepare('SELECT request_id FROM conversation_messages WHERE update_id=? LIMIT 1').get(updateId) as any;
    if(msgRow?.request_id&&this.exists(msgRow.request_id)&&msgRow.request_id!=='system'){
      db.prepare('UPDATE requests SET notice=? WHERE id=?').run('Falha ao processar mensagem do fornecedor no Telegram após 3 tentativas; verifique a conversa.',msgRow.request_id);
    }
  }
  async onModuleInit(){
    this.backfillCompletedQuotes();
    db.prepare("UPDATE tasks SET status='queued' WHERE status='dispatching'").run();
    const sendingDeliveries=db.prepare("SELECT id,request_id FROM telegram_delivery WHERE status='sending'").all() as any[];
    for(const d of sendingDeliveries){
      const uncertainMsg='Envio Telegram interrompido por reinício sem confirmação; entrega incerta, não será repetido automaticamente.';
      db.prepare("UPDATE telegram_delivery SET status='uncertain',error=COALESCE(error,?),next_attempt_at=NULL WHERE id=? AND status='sending'").run(uncertainMsg,d.id);
      if(d.request_id&&d.request_id!=='system'&&this.exists(d.request_id))db.prepare('UPDATE requests SET notice=COALESCE(notice,?) WHERE id=?').run(uncertainMsg,d.request_id);
    }
    db.prepare("UPDATE conversation_messages SET delivery_status='uncertain' WHERE delivery_status='sending'").run();
    const stuckUpdates=db.prepare("SELECT update_id,attempts,error FROM telegram_updates WHERE status='processing'").all() as any[];
    for(const u of stuckUpdates){
      const sd=db.prepare('SELECT * FROM telegram_delivery WHERE source_update_id=?').get(u.update_id) as any;
      if(sd&&this.isPendingPlaceholder(sd.message_text)){
        db.prepare('UPDATE telegram_delivery SET source_update_id=NULL WHERE id=?').run(sd.id);
      }else if(sd&&(sd.status==='sent'||sd.status==='uncertain')){
        db.prepare("UPDATE telegram_updates SET status='processed',retry_after=NULL WHERE update_id=?").run(u.update_id);
        continue;
      }
      if(u.attempts>=3){
        this.markUpdateExhausted(u.update_id,u.error||'Processamento interrompido por reinício após 3 tentativas.');
      }else{
        db.prepare("UPDATE telegram_updates SET status='pending',retry_after=?,error=COALESCE(error,'Processamento retomado após reinício.') WHERE update_id=?").run(new Date().toISOString(),u.update_id);
      }
    }
    let purchasePumpRunning=false;
    const runPurchasePump=()=>{if(purchasePumpRunning)return;purchasePumpRunning=true;void dispatchPurchaseOutbox(db,(...args)=>this.sendTelegram(...args)).catch(()=>{}).finally(()=>{purchasePumpRunning=false;});};
    const pump=()=>{
      this.whatsapp.pump();
      runPurchasePump();
      const nowIso=new Date().toISOString();
      const staleTasks=db.prepare("SELECT * FROM tasks WHERE status='queued' AND created_at<=?").all(new Date(Date.now()-30000).toISOString()) as any[];
      for(const t of staleTasks)void this.dispatch(t);
      for(const d of db.prepare("SELECT * FROM telegram_delivery WHERE status='failed' AND attempts<3 AND (next_attempt_at IS NULL OR next_attempt_at<=?) AND source_update_id IS NULL AND id NOT IN (SELECT delivery_id FROM purchase_outbox WHERE delivery_id IS NOT NULL)").all(nowIso) as any[])void this.retryTelegram(d);
      const expiredProcessing=db.prepare("SELECT update_id,attempts,error FROM telegram_updates WHERE status='processing' AND retry_after IS NOT NULL AND retry_after<=?").all(nowIso) as any[];
      for(const exp of expiredProcessing){
        if(this.activeUpdates.has(exp.update_id))continue;
        if(exp.attempts>=3)this.markUpdateExhausted(exp.update_id,exp.error||'Prazo de processamento excedido após 3 tentativas.');
        else db.prepare("UPDATE telegram_updates SET status='pending',retry_after=? WHERE update_id=? AND status='processing'").run(nowIso,exp.update_id);
      }
      const toExhaust=db.prepare("SELECT update_id,error FROM telegram_updates WHERE status='pending' AND attempts>=3").all() as any[];
      for(const ex of toExhaust)this.markUpdateExhausted(ex.update_id,ex.error||'Limite de 3 tentativas atingido.');
      const pending=db.prepare("SELECT update_id,raw_update FROM telegram_updates WHERE status='pending' AND attempts<3 AND (retry_after IS NULL OR retry_after<=?) ORDER BY received_at LIMIT 5").all(nowIso) as any[];
      for(const u of pending){
        if(this.activeUpdates.has(u.update_id))continue;
        const now=new Date().toISOString();
        const claimed=db.prepare("UPDATE telegram_updates SET status='processing',attempts=attempts+1,retry_after=? WHERE update_id=? AND status='pending' AND attempts<3 AND (retry_after IS NULL OR retry_after<=?)").run(new Date(Date.now()+40000).toISOString(),u.update_id,now);
        if(claimed.changes)void this.telegram(JSON.parse(u.raw_update),process.env.TELEGRAM_WEBHOOK_SECRET||'',true).catch(err=>{
          const row=db.prepare('SELECT attempts FROM telegram_updates WHERE update_id=?').get(u.update_id) as any;
          if((row?.attempts||0)>=3)this.markUpdateExhausted(u.update_id,err);
          else db.prepare("UPDATE telegram_updates SET status='pending',retry_after=?,error=? WHERE update_id=?").run(new Date(Date.now()+10000).toISOString(),this.sanitizeError(err),u.update_id);
        });
      }
    };
    pump();
    setInterval(pump,5000).unref();
  }
  list() { return db.prepare('SELECT * FROM requests ORDER BY created_at DESC').all().map((r: any) => this.expand(r)); }
  messages(id:string){this.get(id);return db.prepare(`SELECT m.id,m.sender_type,m.content,m.created_at,m.channel,m.delivery_status,m.chat_id,
    CASE WHEN m.channel='whatsapp' THEN 'whatsapp:'||COALESCE(c.supplier_id,m.chat_id) ELSE 'telegram:'||COALESCE(m.chat_id,'unknown') END AS supplier_id,
    CASE WHEN m.channel='whatsapp' THEN COALESCE(c.name,'Fornecedor WhatsApp') ELSE 'Fornecedor Telegram' END AS supplier_name
    FROM conversation_messages m LEFT JOIN whatsapp_contacts c ON c.request_id=m.request_id AND c.number=m.chat_id
    WHERE m.request_id=? ORDER BY m.created_at,m.rowid`).all(id);}
  private purchaseSimulationRow(id:string){return db.prepare('SELECT * FROM purchase_simulations WHERE request_id=? ORDER BY created_at DESC LIMIT 1').get(id)||null;}
  purchaseSimulation(id:string){this.get(id);return this.purchaseSimulationRow(id);}
  private cleanText(v:any){if(typeof v!=='string')return null;const s=v.trim();return !s||/^(?:null|none|undefined|n\/a)$/i.test(s)?null:s;}
  private termsSnapshot(q:any){const vu=this.cleanText(q.valid_until),pt=this.cleanText(q.payment_terms),cond=this.cleanText(q.conditions)||'';return JSON.stringify({supplier:q.supplier,unit_cents:q.unit_cents,shipping_cents:q.shipping_cents,fees_cents:q.fees_cents,lead_days:q.lead_days,available_qty:q.available_qty,conditions:cond,...(vu?{valid_until:vu}:{}),...(pt?{payment_terms:pt}:{}),product_confirmed:!!q.product_confirmed,destination_confirmed:!!q.destination_confirmed});}
  private sameSnapshot(q:any,raw:string|null|undefined){if(!q||!raw)return false;if(this.termsSnapshot(q)===raw)return true;try{return this.termsSnapshot(JSON.parse(raw))===this.termsSnapshot(q);}catch{return false;}}
  private backfillCompletedQuotes(){const rows=db.prepare("SELECT id,quote_terms_snapshot FROM requests WHERE quote_completion_state='concluida' AND quote_terms_snapshot IS NOT NULL AND completed_quote_id IS NULL").all() as any[];const update=db.prepare('UPDATE requests SET completed_quote_id=? WHERE id=? AND completed_quote_id IS NULL');for(const r of rows){const quotes=db.prepare('SELECT * FROM quotes WHERE request_id=? ORDER BY created_at DESC').all(r.id) as any[];const match=quotes.find(q=>this.sameSnapshot(q,r.quote_terms_snapshot));if(match)update.run(match.id,r.id);}}
  private explicitYes(text:string){return /^(?:sim|confirmo|confirmado|confirmada|está correto|esta correto|correto|de acordo|pode confirmar|isso mesmo|tudo certo|sim[,!\s]+confirmo(?:\s+(?:tudo|essas condições|as condições|os termos|a cotação))?)[.!\s]*$/i.test(text.trim());}
  private async completeQuote(id:string,chat:string,source:string,sourceUpdateId?:number){const deliveryId=randomUUID();const changed=db.transaction(()=>{const req=db.prepare('SELECT quote_completion_state,status,quote_terms_snapshot FROM requests WHERE id=?').get(id) as any;const quote=db.prepare("SELECT * FROM quotes WHERE request_id=? AND (supplier_chat_id=? OR (supplier_chat_id IS NULL AND event_id GLOB 'telegram:*')) ORDER BY created_at DESC,rowid DESC LIMIT 1").get(id,chat) as any;if(!req||req.status==='concluida'||req.quote_completion_state!=='aguardando_confirmacao'||!quote||quote.unit_cents==null||quote.shipping_cents==null||quote.fees_cents==null||quote.lead_days==null||quote.available_qty==null||!quote.product_confirmed||!quote.destination_confirmed||!this.sameSnapshot(quote,req.quote_terms_snapshot))return false;const row=db.prepare("UPDATE requests SET status=CASE WHEN status='decidida' THEN status ELSE 'concluida' END,quote_completion_state='concluida',quote_final_message_id=?,completed_quote_id=?,version=version+1 WHERE id=? AND quote_completion_state='aguardando_confirmacao' AND status<>'concluida'").run(deliveryId,quote.id,id);if(!row.changes)return false;db.prepare("INSERT INTO telegram_delivery(id,request_id,chat_id,status,error,created_at,message_text,source_update_id) VALUES(?,?,?,'sending',NULL,?,NULL,?)").run(deliveryId,id,chat,new Date().toISOString(),sourceUpdateId??null);return true;})();if(!changed)return {ok:true,duplicate:true};const sent=await this.sendTelegram(deliveryId,id,chat,`Obrigado. A cotação de ${source} foi confirmada e registrada; conversa encerrada.`);return {ok:true,completed:true,pending:!sent};}
  async reconcileConfirmation(id:string){const req=this.get(id);if(req.status==='concluida'||req.quote_completion_state==='concluida')return {ok:true,duplicate:true,status:'concluida'};const rows=db.prepare("SELECT sender_type,content,chat_id FROM conversation_messages WHERE request_id=? AND channel='telegram' ORDER BY created_at DESC,id DESC LIMIT 20").all(id).reverse() as any[];const quote=db.prepare("SELECT * FROM quotes WHERE request_id=? AND (event_id LIKE 'telegram:%' OR event_id LIKE 'recovery:%' OR event_id LIKE 'conversation:%') ORDER BY created_at DESC,rowid DESC LIMIT 1").get(id) as any;const summaries=rows.map((m:any,index:number)=>({m,index})).filter(({m}:any)=>m.sender_type==='AI'&&/Confirma essas condições\?/i.test(m.content));let pair:any=null;for(const {m:summary,index} of summaries){const nextSupplier=rows.slice(index+1).find((entry:any)=>entry.sender_type==='SUPPLIER');if(nextSupplier&&this.explicitYes(nextSupplier.content)){pair={summary,reply:nextSupplier,strict:true};break;}}if(!pair&&quote&&!this.draftMissing(quote,req.qty).length){const prompts=rows.map((m:any,index:number)=>({m,index})).filter(({m}:any)=>m.sender_type==='AI'&&/(?:cotação completa.*você confirma|Pode confirmar esses dados\?|Confirma essas condições\?)/i.test(m.content));for(const {m:summary,index} of prompts){const nextSupplier=rows.slice(index+1).find((entry:any)=>entry.sender_type==='SUPPLIER');if(nextSupplier&&this.explicitYes(nextSupplier.content)){pair={summary,reply:nextSupplier,strict:false};break;}}}if(!pair)return {ok:true,reconciled:false,reason:summaries.length?'explicit-confirmation-not-found':'summary-not-found'};if(!quote||this.draftMissing(quote,req.qty).length)return {ok:true,reconciled:false,reason:'quote-not-found'};const {summary,reply,strict}=pair;if(strict){const values=[quote.supplier,(quote.unit_cents/100).toFixed(2),(quote.shipping_cents/100).toFixed(2),(quote.fees_cents/100).toFixed(2),String(quote.lead_days),String(quote.available_qty)];if(!values.every(v=>summary.content.includes(v)))return {ok:true,reconciled:false,reason:'summary-terms-do-not-match'};}const chat=String(reply.chat_id||quote.supplier_chat_id||'');if(chat&&!quote.supplier_chat_id)db.prepare('UPDATE quotes SET supplier_chat_id=? WHERE id=?').run(chat,quote.id);db.prepare("UPDATE requests SET quote_completion_state='aguardando_confirmacao',quote_terms_snapshot=? WHERE id=? AND quote_completion_state IN ('coletando','aguardando_confirmacao')").run(this.termsSnapshot(quote),id);const desc=strict?summary.content.replace(/^Obrigado! Anotei:\s*/i,'').replace(/^Anotei para\s+/i,'').replace(/\s*Confirma essas condições\?\s*$/i,''):`${quote.supplier}; preço unitário R$ ${(quote.unit_cents/100).toFixed(2)}, frete R$ ${(quote.shipping_cents/100).toFixed(2)}, taxas R$ ${(quote.fees_cents/100).toFixed(2)}, prazo ${quote.lead_days} dias, disponibilidade ${quote.available_qty} unidades.`;return this.completeQuote(id,chat,desc);}
  private async openingMessage(id:string){const req=db.prepare('SELECT product,qty,destination FROM requests WHERE id=?').get(id) as any;if(!req)return '';const history=db.prepare("SELECT sender_type,content FROM conversation_messages WHERE request_id=? AND channel='telegram' ORDER BY created_at DESC LIMIT 12").all(id).reverse();const missing_fields=['supplier','unit_cents','shipping_cents','fees_cents','lead_days','available_qty','product_confirmed','destination_confirmed'];try{const response=await fetch(`${process.env.AGENT_URL||'http://agents:8000'}/conversation-turn`,{method:'POST',headers:{'content-type':'application/json','authorization':`Bearer ${process.env.INTERNAL_API_TOKEN||''}`},body:JSON.stringify({product:req.product,qty:req.qty,destination:req.destination,message:`Solicite uma cotação de ${req.product} para ${req.qty} unidades, com entrega em ${req.destination}.`,history,phase:'opening',terms:null,missing_fields}),signal:AbortSignal.timeout(35000)});if(!response.ok)throw new Error('opening unavailable');const result:any=await response.json();if(result.intent!=='pending'&&typeof result.reply==='string'&&result.reply.trim()&&!this.isPendingPlaceholder(result.reply))return result.reply.trim();}catch{}return `Olá! Você pode cotar ${req.product}, ${req.qty} unidades, para entrega em ${req.destination}? Por favor, informe preço unitário, frete, taxas, prazo, disponibilidade e condições.`;}
  async contactSupplier(id:string,key?:string,supplierId?:string){
    const req=this.get(id);
    if(req.status==='decidida'&&!(this.purchaseSimulationRow(id) as any)?.status)throw new BadRequestException('Solicitação encerrada.');
    if(key&&(key.length>200||key.length<1))throw new BadRequestException('Idempotency-Key inválida.');
    if(key){const cached=db.prepare('SELECT result FROM contact_idempotency WHERE request_id=? AND idempotency_key=?').get(id,key) as any;if(cached){const value=JSON.parse(cached.result);if(supplierId&&value.supplier_id&&value.supplier_id!==supplierId)throw new BadRequestException('Idempotency-Key já usada para outro fornecedor.');return value;}}
    const waContacts=db.prepare('SELECT supplier_id FROM whatsapp_contacts WHERE request_id=? ORDER BY rowid').all(id) as any[];
    if(supplierId&&(!/^[\w-]{1,100}$/.test(supplierId)||!waContacts.some(row=>row.supplier_id===supplierId)))throw new BadRequestException('Fornecedor WhatsApp não está cadastrado nesta solicitação.');
    if(waContacts.length>1&&!supplierId)throw new BadRequestException('Informe supplier_id; há mais de um contato WhatsApp cadastrado.');
    const waContact=waContacts.length>0;
    let result:any;
    if(waContact){
      result={...this.whatsapp.startContact(id,supplierId),request_id:id,channel:'whatsapp',fallback_channel:'telegram',fallback_after_seconds:(Number.isInteger(Number(process.env.WHATSAPP_TELEGRAM_FALLBACK_SECONDS||60))?Math.min(3600,Math.max(1,Number(process.env.WHATSAPP_TELEGRAM_FALLBACK_SECONDS||60))):60)};
    }else{
      const allowed=(process.env.TELEGRAM_ALLOWED_CHAT_IDS||'').split(',').map(x=>x.trim()).filter(Boolean);
      if(!process.env.TELEGRAM_BOT_TOKEN||!allowed.length)throw new BadRequestException('Nenhum contato WhatsApp ou Telegram está configurado.');
      const known=db.prepare('SELECT DISTINCT chat_id FROM telegram_outbound WHERE request_id=?').all(id).map((x:any)=>String(x.chat_id));
      const chats=known.length===1?known:known.length>1?[]:allowed.length===1?allowed:[];
      if(!chats.length)throw new BadRequestException('Informe uma conversa de fornecedor específica; há mais de um chat autorizado.');
      const text=await this.openingMessage(id);let sent=true;
      for(const chat of chats){const deliveryId=randomUUID();db.prepare("INSERT INTO telegram_delivery(id,request_id,chat_id,status,error,created_at,message_text) VALUES(?,?,?,'sending',NULL,?,?)").run(deliveryId,id,chat,new Date().toISOString(),text);sent=!!(await this.sendTelegram(deliveryId,id,chat,text))&&sent;}
      result={ok:sent,request_id:id,status:sent?'sent':'uncertain',channel:'telegram'};
    }
    if(key)db.prepare('INSERT OR IGNORE INTO contact_idempotency VALUES(?,?,?,?)').run(id,key,JSON.stringify(result),new Date().toISOString());
    return result;
  }

  /**
   * Fluxo duplex: (1) liga para o fornecedor via Vapi, (2) envia mensagem Telegram de seguimento.
   * O follow-up Telegram acontece automaticamente via webhook Vapi → agent Python após a ligação.
   * Este endpoint só dispara a chamada; o Telegram é gerenciado pelo hook pós-chamada no backend Python.
   */
  async callSupplier(id: string, body: any) {
    const req = this.get(id);
    if (req.status === 'decidida') throw new BadRequestException('Solicitação decidida não pode iniciar chamada.');
    const phone: string = body?.phone_number || '';
    if (!phone || !/^\+\d{7,19}$/.test(phone)) throw new BadRequestException('Informe phone_number no formato internacional: +5511999999999');
    const agentUrl = process.env.AGENT_URL || 'http://agents:8000';
    const response = await fetch(`${agentUrl}/voice/call`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'authorization': `Bearer ${process.env.INTERNAL_API_TOKEN || ''}` },
      body: JSON.stringify({
        request_id: id,
        phone_number: phone,
        supplier_name: body?.supplier_name || 'Fornecedor',
        item: req.product,
        target_price: body?.target_price || '0',
        qty: req.qty,
        supplier_memory: body?.supplier_memory || '',
        assistant_id: body?.assistant_id || undefined,
        phone_number_id: body?.phone_number_id || undefined,
      }),
      signal: AbortSignal.timeout(25000),
    });
    if (!response.ok) {
      const err: any = await response.json().catch(() => ({}));
      throw new BadRequestException(`Falha ao iniciar chamada: ${err?.detail || err?.message || response.status}`);
    }
    const callResult: any = await response.json();
    // Depois que a ligação terminar, o backend Python dispara o follow-up Telegram automaticamente via webhook Vapi.
    // Aqui registramos a notificação inicial sobre a ligação sendo iniciada.
    void this.telegramNotifyCall(id, req.product, phone);
    return { ok: true, call: callResult, request_id: id };
  }

  private async telegramNotifyCall(requestId: string, product: string, phone: string) {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chats = (process.env.TELEGRAM_ALLOWED_CHAT_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
    if (!token || !chats.length) return;
    const text = `📞 Ligando para o fornecedor sobre "${product}" (${phone}). Aguarde o relatório após a chamada.`;
    for (const chat of chats) {
      const deliveryId = randomUUID();
      db.prepare("INSERT INTO telegram_delivery(id,request_id,chat_id,status,error,created_at,message_text) VALUES(?,?,?,'sending',NULL,?,?)").run(deliveryId, requestId, chat, new Date().toISOString(), text);
      await this.sendTelegram(deliveryId, requestId, chat, text);
    }
  }

  get(id: string): any { const r = db.prepare('SELECT * FROM requests WHERE id=?').get(id) as any; if (!r) throw new NotFoundException('Solicitação não encontrada'); return this.expand(r); }
  async priceHistory(id: string, daysText?: string, sourceUrl?: string) {
    const days = daysText === undefined ? 60 : Number(daysText);
    if (![30, 60, 90].includes(days)) throw new BadRequestException('Período deve ser 30, 60 ou 90 dias.');
    const request = this.get(id);
    const selectedId = request.preferred_market_quote_id || request.decision || request.completed_quote_id;
    const chosen = request.quotes.find((quote: any) => quote.id === selectedId);
    const reference = chosen || request.quotes[0];
    if (sourceUrl) {
      try {
        const url = new URL(sourceUrl);
        if (url.origin !== 'https://www.buscape.com.br' || url.username || url.password || url.search || url.hash || !/^\/[a-z0-9-]+\/[a-z0-9-]+$/.test(url.pathname) || sourceUrl.length>600) throw new Error();
      } catch { throw new BadRequestException('Selecione um endereço de produto válido do Buscapé.'); }
    }
    try {
      const response = await fetch(`${process.env.AGENT_URL || 'http://agents:8000'}/price-timing/analyze`, {
        method: 'POST', headers: {'content-type':'application/json', authorization:`Bearer ${process.env.INTERNAL_API_TOKEN || ''}`},
        body: JSON.stringify({item_name: request.product, days, external_history:true, source_url:sourceUrl || null,
          selected_price: reference ? (reference.unit_cents/100).toFixed(2) : null,
          price_source: chosen ? (request.preferred_market_quote_id || request.decision ? 'selected' : 'negotiated') : reference ? 'reference' : 'unavailable',
          history: []}),
        signal: AbortSignal.timeout(48000),
      });
      if (!response.ok) throw new Error('price timing unavailable');
      return await response.json();
    } catch {
      throw new ServiceUnavailableException('Análise temporal indisponível agora. Atualize para tentar novamente.');
    }
  }
  private exists(id: string) { return id === 'system' || !!db.prepare('SELECT 1 FROM requests WHERE id=?').get(id); }
  remove(id: string) {
    this.whatsapp.cancelContact(id);
    return db.transaction(() => {
      this.get(id);
      // Telegram updates have no request_id; remove only updates linked to this conversation.
      db.prepare('DELETE FROM telegram_updates WHERE update_id IN (SELECT update_id FROM conversation_messages WHERE request_id=? AND update_id IS NOT NULL)').run(id);
      // Ordem respeita as foreign keys (outbox -> simulações -> cotações -> solicitação).
      for (const table of ['purchase_outbox', 'purchase_simulations', 'conversation_drafts', 'reputation_cache', 'quotes', 'tasks', 'telegram_delivery', 'telegram_outbound', 'contact_idempotency',
        'supplier_response_winner', 'whatsapp_contact_flow', 'whatsapp_delivery', 'whatsapp_updates', 'whatsapp_quote_state', 'whatsapp_voice_calls', 'whatsapp_contacts', 'conversation_messages']) {
        db.prepare(`DELETE FROM ${table} WHERE request_id=?`).run(id);
      }
      db.prepare('DELETE FROM requests WHERE id=?').run(id);
      this.turnQueues.delete(id);
      return { ok: true, id };
    })();
  }
  repeat(id: string, body: any = {}) {
    const original = this.get(id);
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !['qty', 'destination'].includes(key)))
      throw new BadRequestException('Informe apenas quantidade e/ou destino para repetir a solicitação.');
    return this.create({ product: original.product, specs: original.specs,
      qty: Object.hasOwn(body, 'qty') ? body.qty : original.qty,
      destination: Object.hasOwn(body, 'destination') ? body.destination : original.destination });
  }
  private expand(r: any): any { const quotes = db.prepare('SELECT * FROM quotes WHERE request_id=? ORDER BY created_at DESC,rowid DESC').all(r.id) as any[]; const draftRow = db.prepare('SELECT chat_id,terms,missing_fields,updated_at FROM conversation_drafts WHERE request_id=? ORDER BY updated_at DESC LIMIT 1').get(r.id) as any; let supplier_draft:any=null; if(draftRow){try{const dt=JSON.parse(draftRow.terms);for(const k of ['valid_until','payment_terms','conditions'])dt[k]=this.cleanText(dt[k]);supplier_draft={chat_id:draftRow.chat_id,terms:dt,missing_fields:JSON.parse(draftRow.missing_fields),updated_at:draftRow.updated_at};}catch{supplier_draft=null;}} const latestRecommendation=db.prepare('SELECT version,result FROM purchase_recommendation_reviews WHERE request_id=? ORDER BY created_at DESC LIMIT 1').get(r.id) as any;let latest_purchase_recommendation:any=null;if(latestRecommendation){try{const saved=JSON.parse(latestRecommendation.result),premium=this.recommendationPremiumPercent();latest_purchase_recommendation={...saved,stale:latestRecommendation.version!==r.version||saved.policy_version!=='supplier-premium-v1'||saved.supplier_max_premium_percent!==premium};}catch{latest_purchase_recommendation=null;}} const whatsapp_pending:any[]=this.whatsapp.pending(r.id); return {...r, whatsapp_pending, latest_purchase_recommendation, specs: JSON.parse(r.specs), agent_analysis:r.agent_analysis?JSON.parse(r.agent_analysis):null, quotes: quotes.map(q => {const subtotal=q.unit_cents*r.qty,total=subtotal+q.shipping_cents+q.fees_cents,safe=Number.isSafeInteger(subtotal)&&Number.isSafeInteger(total);const reasons:string[]=[];if(q.shipping_cents===null)reasons.push('frete pendente');if(q.fees_cents===null)reasons.push('taxas pendentes');if(q.lead_days===null)reasons.push('prazo pendente');if(q.available_qty===null||q.available_qty<r.qty)reasons.push('estoque insuficiente ou não confirmado');if(!q.product_confirmed)reasons.push('produto não confirmado');if(!q.destination_confirmed)reasons.push('destino não confirmado');if(!safe)reasons.push('total excede limite seguro');return {id:q.id,request_id:q.request_id,event_id:q.event_id,supplier:q.supplier,channel:String(q.event_id).startsWith('whatsapp:')?'whatsapp':q.source_url?'market':'telegram',supplier_id:String(q.event_id).startsWith('whatsapp:')?(whatsapp_pending.find((p:any)=>p.terms?.event_id===q.event_id)?.supplier_id||null):q.source_url?`market:${q.supplier}`:q.supplier_chat_id?`telegram:${q.supplier_chat_id}`:null,supplier_chat_id:q.supplier_chat_id,unit_cents:q.unit_cents,shipping_cents:q.shipping_cents,fees_cents:q.fees_cents,unit_price:q.unit_cents/100,shipping:q.shipping_cents===null?null:q.shipping_cents/100,fees:q.fees_cents===null?null:q.fees_cents/100,lead_days:q.lead_days,available_qty:q.available_qty,product_confirmed:!!q.product_confirmed,destination_confirmed:!!q.destination_confirmed,conditions:this.cleanText(q.conditions)||'',valid_until:this.cleanText(q.valid_until),payment_terms:this.cleanText(q.payment_terms),source_url:q.source_url,created_at:q.created_at,tco:safe&&q.shipping_cents!==null&&q.fees_cents!==null?total/100:null,tco_cents:safe&&q.shipping_cents!==null&&q.fees_cents!==null?total:null,eligible:reasons.length===0,eligibility_reasons:reasons};}), completed_quote_id:r.completed_quote_id||null, preferred_market_quote_id:r.preferred_market_quote_id||null, preferred_market_at:r.preferred_market_at||null, supplier_draft, purchase_simulation:this.purchaseSimulationRow(r.id), notice:r.notice}; }
  private async dispatch(t:any){
    const claimed=db.prepare("UPDATE tasks SET status='dispatching' WHERE id=? AND status='queued'").run(t.id);if(!claimed.changes)return;
    const req=db.prepare('SELECT version,execution_version,status FROM requests WHERE id=?').get(t.request_id) as any;if(!req||req.status==='decidida'){db.prepare("UPDATE tasks SET status='completed' WHERE id=?").run(t.id);return;}let version=req.execution_version;if(req.status==='recebida'){version=req.execution_version+1;const moved=db.prepare("UPDATE requests SET status='pesquisando',version=version+1,execution_version=? WHERE id=? AND status='recebida'").run(version,t.request_id);if(!moved.changes){db.prepare("UPDATE tasks SET status='queued' WHERE id=?").run(t.id);return;}}else if(req.status!=='pesquisando'){db.prepare("UPDATE tasks SET status='completed' WHERE id=?").run(t.id);return;}
    try {const response=await fetch(`${process.env.AGENT_URL||'http://agents:8000'}/tasks`,{method:'POST',headers:{'content-type':'application/json','authorization':`Bearer ${process.env.INTERNAL_API_TOKEN||''}`},body:JSON.stringify({task_id:t.id,request_id:t.request_id,execution_version:version,...JSON.parse(t.payload)}),signal:AbortSignal.timeout(10000)}); if(!response.ok)throw new Error(`agent HTTP ${response.status}`); db.prepare("UPDATE tasks SET status='accepted' WHERE id=? AND status='dispatching'").run(t.id); const preferred=this.whatsapp.startContact(t.request_id); if(preferred.status==='no-whatsapp-contact')await this.telegramNotify(t.request_id); else if(!preferred.ok)db.prepare('UPDATE requests SET notice=? WHERE id=?').run('Contato WhatsApp ambíguo; escolha um supplier_id antes de contatar.',t.request_id);}
    catch {db.prepare("UPDATE tasks SET status='queued' WHERE id=? AND status='dispatching'").run(t.id);}
  }
  private async telegramNotify(id:string){if(!this.exists(id))return;const chats=(process.env.TELEGRAM_ALLOWED_CHAT_IDS||'').split(',').map(s=>s.trim()).filter(Boolean);if(!process.env.TELEGRAM_BOT_TOKEN||!chats.length)return;const text=await this.openingMessage(id);for(const chat of chats){if(!this.exists(id))return;if(db.prepare("SELECT 1 FROM telegram_delivery WHERE request_id=? AND chat_id=? AND status IN ('sent','uncertain','sending')").get(id,chat))continue;const deliveryId=randomUUID();db.prepare("INSERT INTO telegram_delivery(id,request_id,chat_id,status,error,created_at,message_text) VALUES(?,?,?,'sending',NULL,?,?)").run(deliveryId,id,chat,new Date().toISOString(),text);await this.sendTelegram(deliveryId,id,chat,text);}}
  private latestTelegramNotice(id:string){return (db.prepare(`SELECT d.error FROM telegram_delivery d WHERE d.request_id=? AND d.status IN ('failed','uncertain')
    AND NOT EXISTS (SELECT 1 FROM telegram_delivery newer WHERE newer.request_id=d.request_id AND newer.chat_id=d.chat_id
      AND (newer.created_at>d.created_at OR (newer.created_at=d.created_at AND newer.rowid>d.rowid)))
    ORDER BY d.created_at DESC,d.rowid DESC LIMIT 1`).get(id) as any)?.error||null;}
  private async retryTelegram(delivery:any){if(!this.exists(delivery.request_id))return;const claimed=db.prepare("UPDATE telegram_delivery SET status='sending' WHERE id=? AND status='failed' AND attempts<3 AND (next_attempt_at IS NULL OR next_attempt_at<=?)").run(delivery.id,new Date().toISOString());if(!claimed.changes)return;let text=delivery.message_text;if(!text)text=await this.openingMessage(delivery.request_id);await this.sendTelegram(delivery.id,delivery.request_id,delivery.chat_id,text);}
  private async sendTelegram(deliveryId:string,id:string,chat:string,text:string):Promise<boolean>{
    if(!this.exists(id))return false;
    db.prepare("UPDATE telegram_delivery SET message_text=?,attempts=attempts+1,next_attempt_at=NULL WHERE id=?").run(text,deliveryId);
    const attempts=(db.prepare('SELECT attempts FROM telegram_delivery WHERE id=?').get(deliveryId) as any)?.attempts||1;
    const retryAt=attempts<3?new Date(Date.now()+5000*attempts).toISOString():null;
    const recordFailure=(status:'failed'|'uncertain',reason:string)=>{db.prepare('UPDATE telegram_delivery SET status=?,error=?,next_attempt_at=? WHERE id=?').run(status,reason,status==='failed'?retryAt:null,deliveryId);db.prepare('UPDATE requests SET notice=? WHERE id=?').run(reason,id);};
    const token=process.env.TELEGRAM_BOT_TOKEN||'';
    try{
      const response=await fetch(`${process.env.TELEGRAM_API_URL||'https://api.telegram.org'}/bot${token}/sendMessage`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({chat_id:chat,text}),signal:AbortSignal.timeout(8000)});
      const data:any=await response.json();
      if(!this.exists(id))return false;
      if(!response.ok||!data.ok){
        const uncertain=response.status>=500||data?.ok!==false;
        recordFailure(uncertain?'uncertain':'failed',uncertain?`Telegram HTTP ${response.status}: entrega sem confirmação; não será repetida automaticamente.`:`Telegram HTTP ${response.status}: falha no envio.`);
        return false;
      }
      if(!Number.isSafeInteger(data?.result?.message_id)){
        recordFailure('uncertain','Telegram respondeu sem identificador válido; entrega incerta, não será repetida automaticamente.');
        return false;
      }
      const notice=(db.prepare('SELECT notice FROM requests WHERE id=?').get(id) as any)?.notice;
      const ownsNotice=notice&&(!!db.prepare('SELECT 1 FROM telegram_delivery WHERE request_id=? AND chat_id=? AND error=? LIMIT 1').get(id,chat,notice)||notice.startsWith('Mensagem do fornecedor recebida; interpretação pendente')||notice.startsWith('Falha ao processar mensagem do fornecedor'));
      db.prepare('INSERT OR IGNORE INTO telegram_outbound(chat_id,message_id,request_id) VALUES(?,?,?)').run(chat,String(data.result.message_id),id);
      db.prepare("UPDATE telegram_delivery SET status='sent',error=NULL,telegram_message_id=?,next_attempt_at=NULL WHERE id=?").run(data.result.message_id,deliveryId);
      if(ownsNotice)db.prepare('UPDATE requests SET notice=? WHERE id=? AND notice=?').run(this.latestTelegramNotice(id),id,notice);
      if(id!=='system')db.prepare("INSERT INTO conversation_messages(id,request_id,chat_id,sender_type,content,delivery_status,telegram_message_id,created_at,channel) VALUES(?,?,?,'AI',?,'sent',?,?,'telegram')").run(randomUUID(),id,chat,text,data.result.message_id,new Date().toISOString());
      return true;
    }catch(error){
      let cause:any=error,code='UNKNOWN';const seen=new Set<any>();
      while(cause&&typeof cause==='object'&&!seen.has(cause)){seen.add(cause);if(typeof cause.code==='string'&&/^[A-Z][A-Z0-9_]{1,63}$/.test(cause.code))code=cause.code;cause=cause.cause;}
      const name=error instanceof Error&&/^[A-Za-z][A-Za-z0-9]{0,39}$/.test(error.name)?error.name:'Error';
      const safe=['ECONNREFUSED','ENOTFOUND','EAI_AGAIN','UND_ERR_CONNECT_TIMEOUT'].includes(code);
      recordFailure(safe?'failed':'uncertain',safe?`Telegram conexão não estabelecida (${name}; cause=${code}); ${attempts<3?'nova tentativa agendada':'limite de 3 tentativas atingido'}.`:`Envio Telegram sem confirmação (${name}; cause=${code}); não será repetido automaticamente para evitar mensagem duplicada.`);
      return false;
    }
  }
  async create(body: any) {
    if (!body || typeof body.product !== 'string' || body.product.trim().length < 2 || body.product.length>300 || !Number.isInteger(body.qty) || body.qty < 1 || body.qty>1000000 || typeof body.destination !== 'string' || body.destination.trim().length<2 || body.destination.length>200 || !body.specs || typeof body.specs!=='object' || Array.isArray(body.specs) || Object.keys(body.specs).length>50 || Object.values(body.specs).some(v=>typeof v!=='string'||v.length>500)) throw new BadRequestException('Produto, especificações, quantidade positiva e destino válidos são obrigatórios.');
    const id = randomUUID(), now = new Date().toISOString();
    const taskId = randomUUID();
    db.transaction(() => {
      db.prepare('INSERT INTO requests(id,product,specs,qty,destination,status,decision,version,created_at) VALUES(?,?,?,?,?,?,?,?,?)').run(id, body.product.trim(), JSON.stringify(body.specs), body.qty, body.destination.trim(), 'recebida', null, 1, now);
      if(!process.env.WHATSAPP_SUPPLIER_NUMBER?.trim())this.whatsapp.registerTestSupplier(id); this.whatsapp.registerConfiguredSupplier(id);
      db.prepare('INSERT INTO tasks VALUES(?,?,?,?,?)').run(taskId,id,'queued',JSON.stringify({product:body.product.trim(),specs:body.specs,qty:body.qty,destination:body.destination.trim()}),now);
    })();
    await this.dispatch(db.prepare('SELECT * FROM tasks WHERE id=?').get(taskId));
    return this.get(id);
  }
  addQuote(id: string, q: any): any { const req=this.get(id);const currentSim=this.purchaseSimulationRow(id) as any;if(currentSim?.status==='confirmed')throw new BadRequestException('Pedido simulado confirmado é final.'); q={...q,shipping_cents:q?.shipping_cents??null,fees_cents:q?.fees_cents??null,lead_days:q?.lead_days??null,available_qty:q?.available_qty??null,product_confirmed:q?.product_confirmed===true,destination_confirmed:q?.destination_confirmed===true}; if (!q || typeof q.supplier !== 'string' || q.supplier.trim().length<1 || q.supplier.length>200 || !this.money(q.unit_cents,false) || !Number.isSafeInteger(q.unit_cents*req.qty) || (q.lead_days!==null&&!Number.isInteger(q.lead_days)) || (q.lead_days!==null&&(q.lead_days<0||q.lead_days>3650)) || (q.available_qty!==null&&!Number.isInteger(q.available_qty)) || (q.available_qty!==null&&(q.available_qty<0||q.available_qty>1000000000)) || (q.shipping_cents!==null&&!this.money(q.shipping_cents,true)) || (q.fees_cents!==null&&!this.money(q.fees_cents,true)) || (q.shipping_cents!==null&&q.fees_cents!==null&&!Number.isSafeInteger(q.unit_cents*req.qty+q.shipping_cents+q.fees_cents)) || (q.source_url!==undefined&&q.source_url!==null&&(typeof q.source_url!=='string'||q.source_url.length>2000||!q.source_url.startsWith('https://')))) throw new BadRequestException('Proposta inválida: centavos inteiros, valores totais seguros, prazo e estoque devem ser confirmados.');
    const eventId=String(q.event_id||randomUUID());if(eventId.length>200)throw new BadRequestException('event_id inválido.');const quoteId=randomUUID(); db.prepare('INSERT OR IGNORE INTO quotes(id,request_id,event_id,supplier,unit_cents,shipping_cents,fees_cents,lead_days,available_qty,conditions,source_url,product_confirmed,destination_confirmed,created_at,supplier_chat_id,valid_until,payment_terms) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(quoteId,id,eventId,q.supplier.trim(),q.unit_cents,q.shipping_cents,q.fees_cents,q.lead_days??null,q.available_qty??null,String(q.conditions||'').slice(0,2000),q.source_url??null,q.product_confirmed?1:0,q.destination_confirmed?1:0,new Date().toISOString(),q.supplier_chat_id??null,q.valid_until??null,q.payment_terms??null);if((db.prepare('SELECT changes() AS n').get() as any).n>0){if(req.quote_completion_state==='aguardando_confirmacao')db.prepare("UPDATE requests SET quote_completion_state='coletando',quote_terms_snapshot=NULL,completed_quote_id=NULL WHERE id=?").run(id);const sim=this.purchaseSimulationRow(id) as any;if(sim&&sim.status==='awaiting_supplier'){db.prepare("UPDATE purchase_simulations SET status='review_required' WHERE id=?").run(sim.id);db.prepare("UPDATE purchase_outbox SET status='cancelled' WHERE simulation_id=? AND status='queued'").run(sim.id);}}db.prepare("UPDATE requests SET status='comparação',notice=NULL,version=version+1 WHERE id=? AND status NOT IN ('decidida','concluida')").run(id);return this.get(id); }
  private money(n:any,zero:boolean){return Number.isSafeInteger(n)&&n>=(zero?0:1)&&n<=999999999999;}
  decide(id:string,b:any,key:string|undefined){const req=this.get(id);if(!key&&b?.confirmed===undefined&&req.status!=='decidida'&&req.quote_completion_state!=='concluida'&&Number.isInteger(b?.version)&&b.version===req.version&&req.quotes.some((row:any)=>row.id===b?.quote_id&&row.eligible)){const res=db.prepare("UPDATE requests SET status='decidida',decision=?,notice=NULL,version=version+1 WHERE id=? AND version=? AND status<>'decidida'").run(b.quote_id,id,b.version);if(!res.changes)throw new BadRequestException('A solicitação mudou; recarregue antes de decidir.');return this.get(id);}if(!key||key.length>200)throw new BadRequestException('Idempotency-Key obrigatória.');const prior=db.prepare('SELECT * FROM purchase_simulations WHERE request_id=? AND idempotency_key=?').get(id,key) as any;if(prior){if(prior.quote_id!==b?.quote_id)throw new BadRequestException('Idempotency-Key já usada para outra cotação.');return this.get(id);}if(b?.confirmed!==true||!Number.isInteger(b.version)||b.version!==req.version)throw new BadRequestException('Confirmação humana e versão atual são obrigatórias.');if(req.quote_completion_state!=='concluida')throw new BadRequestException('A cotação precisa estar explicitamente concluída pelo fornecedor.');const q=db.prepare('SELECT * FROM quotes WHERE id=? AND request_id=?').get(b.quote_id,id) as any;if(!q||req.completed_quote_id!==b.quote_id||!this.sameSnapshot(q,req.quote_terms_snapshot)||!req.quotes.some((row:any)=>row.id===b.quote_id&&row.eligible))throw new BadRequestException('Selecione uma cotação elegível desta solicitação.');const chat=q.supplier_chat_id;if(!chat)throw new BadRequestException('A cotação não tem fornecedor Telegram correspondente.');const snapshot=req.quote_terms_snapshot||this.termsSnapshot(q);const active=db.prepare("SELECT * FROM purchase_simulations WHERE request_id=? AND status IN ('awaiting_supplier','confirmed')").get(id) as any;const priorSimulation=db.prepare('SELECT * FROM purchase_simulations WHERE request_id=? ORDER BY created_at DESC LIMIT 1').get(id) as any;if(active)throw new BadRequestException('Já existe uma simulação para esta solicitação.');if(priorSimulation&&priorSimulation.status!=='review_required')throw new BadRequestException('A simulação anterior é final e não pode ser duplicada.');const simId=randomUUID(),now=new Date().toISOString();const tx=db.transaction(()=>{const fresh=db.prepare('SELECT version,quote_completion_state FROM requests WHERE id=?').get(id) as any;if(fresh.version!==b.version||fresh.quote_completion_state!=='concluida')throw new BadRequestException('A solicitação mudou; recarregue antes de decidir.');db.prepare("INSERT INTO purchase_simulations(id,request_id,quote_id,snapshot,status,created_at,idempotency_key) VALUES(?,?,?,?, 'awaiting_supplier',?,?)").run(simId,id,q.id,snapshot,now,key);db.prepare("INSERT INTO purchase_outbox(id,simulation_id,request_id,quote_id,chat_id,status,created_at) VALUES(?,?,?,?,?,'queued',?)").run(randomUUID(),simId,id,q.id,String(chat),now);db.prepare("UPDATE requests SET status='decidida',decision=?,preferred_market_quote_id=NULL,preferred_market_at=NULL,version=version+1 WHERE id=? AND version=?").run(q.id,id,b.version);});tx();return this.get(id);}
  marketPreference(id:string,b:any){const req=this.get(id);if(!b||!Number.isInteger(b.version)||b.version!==req.version)throw new BadRequestException('Versão atual da solicitação é obrigatória.');if(req.status!=='concluida'&&req.status!=='decidida'&&req.quote_completion_state!=='concluida')throw new BadRequestException('Conclua a cotação antes de registrar a preferência final.');const active=db.prepare("SELECT * FROM purchase_simulations WHERE request_id=? AND status IN ('awaiting_supplier','confirmed')").get(id) as any;if(active)throw new BadRequestException('Cancele a simulação ativa com o fornecedor antes de selecionar uma opção da internet.');if(b.quote_id===null){const res=db.prepare('UPDATE requests SET preferred_market_quote_id=NULL,preferred_market_at=NULL,version=version+1 WHERE id=? AND version=?').run(id,b.version);if(!res.changes)throw new BadRequestException('A solicitação mudou; recarregue antes de decidir.');return this.get(id);}if(typeof b.quote_id!=='string'||!b.quote_id.trim())throw new BadRequestException('Selecione uma oferta válida da internet.');const q=db.prepare('SELECT * FROM quotes WHERE id=? AND request_id=?').get(b.quote_id,id) as any;if(!q||typeof q.source_url!=='string'||!q.source_url.startsWith('https://'))throw new BadRequestException('A oferta selecionada não é uma opção válida da internet.');const res=db.prepare('UPDATE requests SET preferred_market_quote_id=?,preferred_market_at=?,version=version+1 WHERE id=? AND version=?').run(q.id,new Date().toISOString(),id,b.version);if(!res.changes)throw new BadRequestException('A solicitação mudou; recarregue antes de decidir.');return this.get(id);}
  private recommendationPremiumPercent(){const raw=process.env.SUPPLIER_MAX_PREMIUM_PERCENT;if(raw===undefined||raw.trim()==='')return DEFAULT_SUPPLIER_MAX_PREMIUM_PERCENT;const percent=Number(raw);if(!Number.isFinite(percent)||percent<0||percent>100)throw new ServiceUnavailableException('SUPPLIER_MAX_PREMIUM_PERCENT deve estar entre 0 e 100.');return percent;}
  private recommendationOffers(req:any):RecommendationOffer[]{const isMarket=(q:any)=>!!q.source_url&&!q.supplier_chat_id&&!String(q.event_id).startsWith('telegram:')&&!String(q.event_id).startsWith('whatsapp:');const direct=req.quotes.filter((q:any)=>!isMarket(q));const latestDirect=direct.filter((q:any,index:number)=>direct.findIndex((other:any)=>other.channel===q.channel&&(other.supplier_id||other.supplier)===(q.supplier_id||q.supplier))===index);const canonical=direct.find((q:any)=>q.id===req.completed_quote_id&&req.quote_completion_state==='concluida'&&this.sameSnapshot(q,req.quote_terms_snapshot));const chosen=[...req.quotes.filter(isMarket),...(canonical?[canonical]:[]),...latestDirect.filter((q:any)=>q.id!==canonical?.id)];return [...new Map(chosen.map((q:any)=>[q.id,q])).values()].map((q:any)=>({id:q.id,supplier:q.supplier,event_id:q.event_id,supplier_chat_id:q.supplier_chat_id,unit_cents:q.unit_cents,shipping_cents:q.shipping_cents,fees_cents:q.fees_cents,lead_days:q.lead_days,available_qty:q.available_qty,conditions:q.conditions,product_confirmed:q.product_confirmed,destination_confirmed:q.destination_confirmed,source_url:q.source_url,eligible:q.eligible,tco_cents:q.tco_cents,valid_until:q.valid_until,listing_product_name:isMarket(q)?String(q.conditions||'').split(' | ')[0].slice(0,300):null,is_completed_supplier:q.id===req.completed_quote_id&&req.quote_completion_state==='concluida'&&this.sameSnapshot(q,req.quote_terms_snapshot)}));}
  async purchaseRecommendation(id:string,b:any){
    const req=this.get(id);if(!b||!Number.isInteger(b.version)||b.version!==req.version)throw new ConflictException('A solicitação mudou; recarregue antes de gerar a recomendação.');
    const premium=this.recommendationPremiumPercent(),offers=this.recommendationOffers(req),context={policy:'supplier-premium-v1',product:req.product,specs:req.specs,qty:req.qty},offerHash=hashRecommendationInputs(offers,premium,context);
    if(!offers.length){const result:any=createRecommendationSummary(id,req.version,premium,[],{},'',null,req.qty);result.policy_version='supplier-premium-v1';result.reason='no_offers';result.explanation='Ainda não há ofertas para comparar.';db.prepare('INSERT INTO purchase_recommendation_reviews(review_id,request_id,version,offer_hash,factor,request_payload,result,created_at) VALUES(?,?,?,?,?,?,?,?)').run(result.review_id,id,req.version,offerHash,premium,'{}',JSON.stringify(result),result.created_at);return result;}
    const key=process.env.TYPESAFE_API_KEY||process.env.JEV_API_KEY;if(!key)throw new ServiceUnavailableException('Recomendação indisponível: configure TYPESAFE_API_KEY ou JEV_API_KEY no servidor.');
    const payload=buildJevRecommendationPayload({product:req.product,specs:req.specs,qty:req.qty,destination:req.destination},offers);
    let response:Response;try{response=await fetch(process.env.TYPESAFE_API_URL||'https://api.typesafe.ai/v1/systemone',{method:'POST',headers:{authorization:`Bearer ${key}`,'content-type':'application/json'},body:JSON.stringify(payload),signal:AbortSignal.timeout(30000)});}catch{throw new ServiceUnavailableException('Jev está indisponível no momento; nenhuma recomendação foi salva.');}
    if(!response.ok)throw new ServiceUnavailableException(`Jev recusou a avaliação (HTTP ${response.status}); nenhuma recomendação foi salva.`);
    let data:any;try{data=await response.json();}catch{throw new ServiceUnavailableException('Resposta inválida do Jev; nenhuma recomendação foi salva.');}
    if(!data?.answers||typeof data.answers!=='object')throw new ServiceUnavailableException('Resposta incompleta do Jev; nenhuma recomendação foi salva.');
    const result:any=createRecommendationSummary(id,req.version,premium,offers,data.answers,typeof data.explanation==='string'?data.explanation:'',req.completed_quote_id||null,req.qty);result.policy_version='supplier-premium-v1';
    const tx=db.transaction(()=>{const current=db.prepare('SELECT version FROM requests WHERE id=?').get(id) as any;if(!current||current.version!==req.version)throw new ConflictException('A solicitação mudou durante a avaliação; gere uma nova recomendação.');const fresh=this.get(id),freshHash=hashRecommendationInputs(this.recommendationOffers(fresh),this.recommendationPremiumPercent(),{policy:'supplier-premium-v1',product:fresh.product,specs:fresh.specs,qty:fresh.qty});if(freshHash!==offerHash)throw new ConflictException('As ofertas mudaram durante a avaliação; gere uma nova recomendação.');db.prepare('INSERT INTO purchase_recommendation_reviews(review_id,request_id,version,offer_hash,factor,request_payload,result,created_at) VALUES(?,?,?,?,?,?,?,?)').run(result.review_id,id,req.version,offerHash,premium,JSON.stringify(payload),JSON.stringify(result),result.created_at);});tx();return result;
  }
  approvePurchaseRecommendation(id:string,b:any){
    if(!b||typeof b.review_id!=='string'||!b.review_id||typeof b.approved!=='boolean'||!Number.isInteger(b.version))throw new BadRequestException('Informe review_id, approved e version.');
    const req=this.get(id);if(req.version!==b.version)throw new ConflictException('A solicitação mudou; atualize antes de aprovar esta recomendação.');
    const review=db.prepare('SELECT * FROM purchase_recommendation_reviews WHERE review_id=? AND request_id=?').get(b.review_id,id) as any;if(!review)throw new NotFoundException('Revisão de recomendação não encontrada.');
    const result=JSON.parse(review.result);if(review.version!==b.version)throw new ConflictException('Esta recomendação pertence a uma versão antiga da solicitação.');if(result.policy_version!=='supplier-premium-v1')throw new ConflictException('Esta recomendação usa uma política antiga; gere uma nova recomendação.');
    const premium=this.recommendationPremiumPercent(),offers=this.recommendationOffers(req),hash=hashRecommendationInputs(offers,premium,{policy:'supplier-premium-v1',product:req.product,specs:req.specs,qty:req.qty});if(hash!==review.offer_hash||premium!==review.factor)throw new ConflictException('As ofertas ou a política de comparação mudaram; gere uma nova recomendação.');
    if(review.approved!==null){if(Boolean(review.approved)!==b.approved)throw new ConflictException('Esta revisão já foi registrada com outra resposta.');return {review_id:review.review_id,approved:b.approved,selected_offer_id:result.approval?.selected_offer_id??null,version:req.version,request:req,latest_purchase_recommendation:result};}
    const latestReview=db.prepare('SELECT review_id FROM purchase_recommendation_reviews WHERE request_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1').get(id) as any;if(latestReview?.review_id!==review.review_id)throw new ConflictException('Uma recomendação mais recente substituiu esta revisão.');
    if(b.approved&&!result.selected_offer_id)throw new BadRequestException('Esta revisão não tem uma oferta recomendada para aprovar.');
    if(b.approved&&result.candidates.some((c:any)=>c.offer_id===result.selected_offer_id&&c.expired))throw new ConflictException('A oferta recomendada expirou; gere uma nova recomendação.');
    if(b.approved){const selected=db.prepare('SELECT valid_until FROM quotes WHERE id=? AND request_id=?').get(result.selected_offer_id,id) as any;const expires=selected?.valid_until?Date.parse(selected.valid_until):Number.NaN;if(Number.isFinite(expires)&&expires<Date.now())throw new ConflictException('A oferta recomendada expirou; gere uma nova recomendação.');}
    const now=new Date().toISOString(),next={...result,approval:{approved:b.approved,selected_offer_id:b.approved?result.selected_offer_id:null,at:now}};
    const tx=db.transaction(()=>{const fresh=db.prepare('SELECT version FROM requests WHERE id=?').get(id) as any;if(!fresh||fresh.version!==b.version)throw new ConflictException('A solicitação mudou; atualize antes de aprovar esta recomendação.');const current=db.prepare('SELECT approved,offer_hash,factor FROM purchase_recommendation_reviews WHERE review_id=? AND request_id=?').get(review.review_id,id) as any;if(!current||current.approved!==null||current.offer_hash!==hash||current.factor!==premium)throw new ConflictException('Esta revisão mudou; gere uma nova recomendação.');db.prepare('UPDATE purchase_recommendation_reviews SET approved=?,result=?,approved_at=? WHERE review_id=? AND approved IS NULL').run(b.approved?1:0,JSON.stringify(next),now,review.review_id);});tx();return {review_id:review.review_id,approved:b.approved,selected_offer_id:next.approval.selected_offer_id,version:req.version,request:this.get(id),latest_purchase_recommendation:next};
  }
  cancelPurchase(id:string){const sim=this.purchaseSimulationRow(id) as any;if(!sim){this.get(id);throw new NotFoundException('Simulação inexistente');}if(['confirmed','rejected','cancelled'].includes(sim.status))return this.get(id);db.prepare("UPDATE purchase_simulations SET status='cancelled' WHERE id=? AND status IN ('awaiting_supplier','review_required')").run(sim.id);db.prepare("UPDATE purchase_outbox SET status='cancelled' WHERE simulation_id=? AND status='queued'").run(sim.id);return this.get(id);}
  async refreshReputation(id:string){const req=this.get(id),cached=db.prepare('SELECT refreshed_at FROM reputation_cache WHERE request_id=?').get(id) as any;const prevReps=Array.isArray(req.agent_analysis?.reputations)?req.agent_analysis.reputations:[];const hasTransientFailure=prevReps.length>0&&!prevReps.some((r:any)=>r?.verified)&&prevReps.some((r:any)=>['timeout','skipped_timeout','unavailable','blocked'].includes(r?.status));const ttlMs=hasTransientFailure?120000:86400000;if(cached&&Date.now()-Date.parse(cached.refreshed_at)<ttlMs)return {request:this.get(id),cached:true};const response=await fetch(`${process.env.AGENT_URL||'http://agents:8000'}/reputation-refresh`,{method:'POST',headers:{'content-type':'application/json','authorization':`Bearer ${process.env.INTERNAL_API_TOKEN||''}`},body:JSON.stringify({offers:req.quotes}),signal:AbortSignal.timeout(35000)});if(!response.ok)throw new BadRequestException('Atualização de reputação indisponível.');const data:any=await response.json();const tx=db.transaction(()=>{db.prepare('UPDATE requests SET agent_analysis=? WHERE id=?').run(JSON.stringify({...req.agent_analysis,reputations:data.reputations,reputation_indications:data.reputation_indications}),id);db.prepare('INSERT INTO reputation_cache(request_id,refreshed_at) VALUES(?,?) ON CONFLICT(request_id) DO UPDATE SET refreshed_at=excluded.refreshed_at').run(id,new Date().toISOString());});tx();return {request:this.get(id),cached:false};}
  private draftTerms(id:string,chat:string){const row=db.prepare('SELECT * FROM conversation_drafts WHERE request_id=? AND chat_id=?').get(id,chat) as any;return row?{...row,terms:JSON.parse(row.terms),missing_fields:JSON.parse(row.missing_fields),validation_errors:JSON.parse(row.validation_errors)}:null;}
  private draftMissing(t:any,qty:number){const missing:string[]=[];if(!this.money(t?.unit_cents,false))missing.push('unit_cents');if(!this.money(t?.shipping_cents,true))missing.push('shipping_cents');if(!this.money(t?.fees_cents,true))missing.push('fees_cents');if(!Number.isInteger(t?.lead_days)||t.lead_days<0||t.lead_days>3650)missing.push('lead_days');if(!Number.isInteger(t?.available_qty)||t.available_qty<qty)missing.push('available_qty');if(t?.product_confirmed!==true&&t?.product_confirmed!==1)missing.push('product_confirmed');if(t?.destination_confirmed!==true&&t?.destination_confirmed!==1)missing.push('destination_confirmed');if(this.money(t?.unit_cents,false)&&t.shipping_cents!=null&&t.fees_cents!=null&&!Number.isSafeInteger(t.unit_cents*qty+t.shipping_cents+t.fees_cents))missing.push('safe_total');return missing;}
  private draftReply(t:any,missing:string[]){const parts:string[]=[];if(this.money(t?.unit_cents,false))parts.push(`preço unitário R$ ${(t.unit_cents/100).toFixed(2)}`);if(this.money(t?.shipping_cents,true))parts.push(`frete R$ ${(t.shipping_cents/100).toFixed(2)}`);if(this.money(t?.fees_cents,true))parts.push(`taxas R$ ${(t.fees_cents/100).toFixed(2)}`);if(t?.lead_days!=null)parts.push(`prazo ${t.lead_days} dias`);if(t?.available_qty!=null)parts.push(`disponibilidade ${t.available_qty} unidades`);if(t?.valid_until)parts.push(`validade ${t.valid_until}`);if(t?.payment_terms)parts.push(`pagamento: ${t.payment_terms}`);if(t?.conditions)parts.push(`condições: ${t.conditions}`);const labels:any={unit_cents:'preço unitário',shipping_cents:'frete',fees_cents:'taxas adicionais (ou confirmação de que não há)',lead_days:'prazo',available_qty:'estoque para a quantidade solicitada',product_confirmed:'confirmação de que o produto atende ao solicitado',destination_confirmed:'confirmação de entrega no CEP solicitado',safe_total:'valores que permitam calcular um total seguro'};const summary=parts.length?`Anotei para ${t.supplier}: ${parts.join('; ')}.`:'Ainda não tenho todos os valores da cotação anotados.';return missing.length?`${summary} Para completar, preciso de ${missing.map(k=>labels[k]||k).join(', ')}. Pode confirmar esses dados?`:`${summary} Confirma essas condições?`;}
  private persistDraft(id:string,input:any,patch:any,prior:any){const chat=String(input.chat_id||''),req=this.get(id),existing=this.draftTerms(id,chat);const t:any={};const fields=['supplier','unit_cents','shipping_cents','fees_cents','lead_days','available_qty','conditions','valid_until','payment_terms','product_confirmed','destination_confirmed'];for(const field of fields)t[field]=existing?.terms?.[field]??prior?.[field]??null;for(const flag of ['product_confirmed','destination_confirmed'])t[flag]=t[flag]===true||t[flag]===1;const errors:string[]=[];
    if(patch&&typeof patch==='object'&&!Array.isArray(patch))for(const field of fields){const rawVal=patch[field];const value=typeof rawVal==='string'&&!field.endsWith('_cents')&&!field.endsWith('_confirmed')&&field!=='lead_days'&&field!=='available_qty'?this.cleanText(rawVal):rawVal;if(value==null||value==='')continue;let valid=true;if(field.endsWith('_cents'))valid=this.money(value,field!=='unit_cents');else if(field==='lead_days')valid=Number.isInteger(value)&&value>=0&&value<=3650;else if(field==='available_qty')valid=Number.isInteger(value)&&value>=0&&value<=1000000000;else if(field.endsWith('_confirmed'))valid=typeof value==='boolean';else valid=typeof value==='string'&&value.trim().length>0&&value.length<=(field==='supplier'?200:field==='valid_until'?100:field==='payment_terms'?500:2000);if(!valid){errors.push(field);continue;}if(field==='conditions'&&t.conditions&&value!==t.conditions){t.conditions=value.includes(t.conditions)?value:t.conditions.includes(value)?t.conditions:`${t.conditions}\n${value}`;}else t[field]=field==='supplier'?value.trim():value;}
    for(const k of ['valid_until','payment_terms','conditions'])t[k]=this.cleanText(t[k]);
    const rawName=(db.prepare(`SELECT json_extract(u.raw_update,'$.message.from.first_name') AS name FROM conversation_messages m JOIN telegram_updates u ON u.update_id=m.update_id WHERE m.request_id=? AND m.chat_id=? AND CAST(json_extract(u.raw_update,'$.message.chat.id') AS TEXT)=? AND CAST(json_extract(u.raw_update,'$.message.from.id') AS TEXT)=? ORDER BY m.created_at DESC,m.rowid DESC LIMIT 1`).get(id,chat,chat,chat) as any)?.name;
    const name=typeof input.supplier_name==='string'?input.supplier_name:rawName;
    if(!t.supplier){const candidate=typeof name==='string'?name.trim().slice(0,180):'';t.supplier=candidate&&/^[\p{L}\p{N}][\p{L}\p{N} ._'’-]{0,179}$/u.test(candidate)?`Contato ${candidate}`:'Fornecedor Telegram';}
    const baseline=existing?.terms||(prior?{supplier:prior.supplier??null,unit_cents:prior.unit_cents??null,shipping_cents:prior.shipping_cents??null,fees_cents:prior.fees_cents??null,lead_days:prior.lead_days??null,available_qty:prior.available_qty??null,conditions:prior.conditions??null,valid_until:prior.valid_until??null,payment_terms:prior.payment_terms??null,product_confirmed:prior.product_confirmed===true||prior.product_confirmed===1,destination_confirmed:prior.destination_confirmed===true||prior.destination_confirmed===1}:null);
    const missing=this.draftMissing(t,req.qty),changed=!baseline||JSON.stringify(baseline)!==JSON.stringify(t);const apply=db.transaction(()=>{
      db.prepare(`INSERT INTO conversation_drafts(request_id,chat_id,terms,missing_fields,validation_errors,version,updated_at) VALUES(?,?,?,?,?,1,?) ON CONFLICT(request_id,chat_id) DO UPDATE SET terms=excluded.terms,missing_fields=excluded.missing_fields,validation_errors=excluded.validation_errors,version=conversation_drafts.version+1,updated_at=excluded.updated_at`).run(id,chat,JSON.stringify(t),JSON.stringify(missing),JSON.stringify(errors),new Date().toISOString());
      const priorTerms=prior?this.termsSnapshot(prior):null;let quoteChanged=false;
      if(this.money(t.unit_cents,false)&&this.termsSnapshot(t)!==priorTerms){const event=input.reprocess?`recovery:${input.message_id}:${createHash('sha256').update(this.termsSnapshot(t)).digest('hex').slice(0,20)}`:input.update_id!==undefined?`telegram:${input.update_id}`:`conversation:${randomUUID()}`;const duplicate=db.prepare('SELECT 1 FROM quotes WHERE request_id=? AND event_id=?').get(id,event);if(!duplicate){db.prepare("UPDATE requests SET quote_completion_state='coletando',quote_terms_snapshot=NULL,completed_quote_id=NULL,version=version+1 WHERE id=?").run(id);this.addQuote(id,{...t,event_id:event,supplier_chat_id:chat||null});quoteChanged=true;}}
      if(!this.money(t.unit_cents,false)&&changed)db.prepare("UPDATE requests SET quote_completion_state='coletando',quote_terms_snapshot=NULL,completed_quote_id=NULL,version=version+1 WHERE id=?").run(id);
      if(quoteChanged&&!missing.length)db.prepare("UPDATE requests SET quote_completion_state='aguardando_confirmacao',quote_terms_snapshot=? WHERE id=?").run(this.termsSnapshot(t),id);
      return {terms:t,missing_fields:missing,validation_errors:errors,changed:changed||quoteChanged,reply:this.draftReply(t,missing)};
    });return apply();}
  reprocessConversation(id:string,body:any,key?:string){return this.withTurnLock(id,()=>this.reprocessConversationUnlocked(id,body,key));}
  private async reprocessConversationUnlocked(id:string,body:any,key?:string){this.get(id);const chats=db.prepare("SELECT DISTINCT chat_id FROM conversation_messages WHERE request_id=? AND sender_type='SUPPLIER' AND chat_id IS NOT NULL AND channel='telegram'").all(id) as any[];const chat=body?.chat_id?String(body.chat_id):chats.length===1?String(chats[0].chat_id):null;if(!chat||!chats.some(r=>String(r.chat_id)===chat))throw new BadRequestException('Informe o chat correspondente ao histórico do fornecedor.');if(body?.send===true&&(!key||key.length>160))throw new BadRequestException('Idempotency-Key obrigatória para enviar o resumo recuperado.');const cacheKey=`recover:${key||''}`;const cache=key?db.prepare('SELECT result FROM contact_idempotency WHERE request_id=? AND idempotency_key=?').get(id,cacheKey) as any:null;if(cache)return JSON.parse(cache.result);
    const rows=db.prepare("SELECT id,update_id,sender_type,content FROM conversation_messages WHERE request_id=? AND channel='telegram' AND (chat_id=? OR chat_id IS NULL) ORDER BY created_at,rowid LIMIT 201").all(id,chat) as any[];if(rows.length>200)throw new BadRequestException('Histórico excede 200 mensagens; selecione uma conversa menor.');let result:any;const history:any[]=[];for(const row of rows){if(row.sender_type!=='SUPPLIER'){if(!this.isPendingPlaceholder(row.content))history.push({sender_type:'AI',content:row.content});continue;}result=await this.conversationTurnUnlocked(id,{message:row.content,chat_id:chat,update_id:row.update_id,message_id:row.id,reprocess:true,history_override:history.slice()});if(result.intent==='pending')return {ok:false,pending:true,reply:result.reply,request:this.get(id)};history.push({sender_type:'SUPPLIER',content:row.content});}const draft=this.draftTerms(id,chat);if(!draft)throw new BadRequestException('Não foi possível recuperar o rascunho.');const reply=this.draftReply(draft.terms,draft.missing_fields);const previous=db.prepare("SELECT content FROM conversation_messages WHERE request_id=? AND chat_id=? AND sender_type='AI' ORDER BY created_at DESC,rowid DESC LIMIT 1").get(id,chat) as any;const response:any={ok:true,reply,draft,request:this.get(id),sent:false};if(body?.send===true&&previous?.content!==reply){const deliveryId=randomUUID();db.prepare("INSERT INTO telegram_delivery(id,request_id,chat_id,status,created_at,message_text) VALUES(?,?,?,'sending',?,?)").run(deliveryId,id,chat,new Date().toISOString(),reply);db.prepare('INSERT INTO contact_idempotency VALUES(?,?,?,?)').run(id,cacheKey,JSON.stringify({...response,delivery_id:deliveryId,pending:true}),new Date().toISOString());response.sent=await this.sendTelegram(deliveryId,id,chat,reply);response.delivery_id=deliveryId;db.prepare('UPDATE contact_idempotency SET result=? WHERE request_id=? AND idempotency_key=?').run(JSON.stringify(response),id,cacheKey);}return response;}
  conversationTurn(id:string,input:any){return this.withTurnLock(id,()=>this.conversationTurnUnlocked(id,input));}
  private async conversationTurnUnlocked(id:string,input:any){const req=this.get(id);const startVersion=req.version,startPhase=req.quote_completion_state; if(!input||typeof input.message!=='string'||!input.message.trim())throw new BadRequestException('Mensagem obrigatória.');const activeSim=this.purchaseSimulationRow(id) as any;const activeQuote=req.completed_quote_id?db.prepare('SELECT supplier_chat_id FROM quotes WHERE id=?').get(req.completed_quote_id) as any:null;if(activeSim?.status==='awaiting_supplier'&&activeQuote?.supplier_chat_id&&input.chat_id&&String(activeQuote.supplier_chat_id)!==String(input.chat_id))return {intent:'purchase',reply:'Esta simulação está vinculada a outro fornecedor.',terms:null,explicit_confirmation:false,terms_changed:false,purchase_acceptance:'unclear',phase:'purchase'};const rawHistory=input.history_override|| (input.chat_id?db.prepare("SELECT sender_type AS sender_type,content FROM conversation_messages WHERE request_id=? AND chat_id=? AND channel='telegram' ORDER BY created_at DESC LIMIT 12").all(id,String(input.chat_id)).reverse() as any[]:db.prepare("SELECT sender_type AS sender_type,content FROM conversation_messages WHERE request_id=? AND chat_id IS NULL AND channel='telegram' ORDER BY created_at DESC LIMIT 12").all(id).reverse() as any[]);const history=rawHistory.filter((m:any)=>!(m.sender_type==='AI'&&this.isPendingPlaceholder(m.content)));const priorQuote=input.chat_id?db.prepare("SELECT * FROM quotes WHERE request_id=? AND supplier_chat_id=? ORDER BY created_at DESC LIMIT 1").get(id,String(input.chat_id)) as any:db.prepare("SELECT * FROM quotes WHERE request_id=? AND id=? AND supplier_chat_id IS NOT NULL").get(id,req.completed_quote_id||'!') as any;const prior=this.draftTerms(id,String(input.chat_id||''))?.terms||priorQuote;const sim=this.purchaseSimulationRow(id) as any;const phase=sim?.status==='awaiting_supplier'?'purchase':req.quote_completion_state==='concluida'?'quote_completed':req.quote_completion_state==='aguardando_confirmacao'?'quote_confirmation':prior||input.update_id!==undefined?'quotation':'opening';const missing_fields:string[]=[];if(!prior?.unit_cents)missing_fields.push('unit_cents');if(prior?.shipping_cents==null)missing_fields.push('shipping_cents');if(prior?.fees_cents==null)missing_fields.push('fees_cents');if(prior?.lead_days==null)missing_fields.push('lead_days');if(prior?.available_qty==null)missing_fields.push('available_qty');if(!prior?.product_confirmed)missing_fields.push('product_confirmed');if(!prior?.destination_confirmed)missing_fields.push('destination_confirmed');const priorPayload=prior?{supplier:prior.supplier,unit_cents:prior.unit_cents,shipping_cents:prior.shipping_cents,fees_cents:prior.fees_cents,lead_days:prior.lead_days,available_qty:prior.available_qty,conditions:prior.conditions,valid_until:prior.valid_until??null,payment_terms:prior.payment_terms??null,product_confirmed:!!prior.product_confirmed,destination_confirmed:!!prior.destination_confirmed}:null;let result:any;try{const response=await fetch(`${process.env.AGENT_URL||'http://agents:8000'}/conversation-turn`,{method:'POST',headers:{'content-type':'application/json','authorization':`Bearer ${process.env.INTERNAL_API_TOKEN||''}`},body:JSON.stringify({product:req.product,qty:req.qty,destination:req.destination,message:input.message,history,phase,terms:priorPayload,missing_fields}),signal:AbortSignal.timeout(35000)});if(!response.ok)throw new Error(`conversation service HTTP ${response.status}`);result=await response.json();}catch(err){result={intent:'pending',reply:'Não consegui processar esta mensagem agora; ela continua pendente para nova tentativa.',terms:priorPayload,explicit_confirmation:false,terms_changed:false,purchase_acceptance:'unclear',error_detail:this.sanitizeError(err)};}
    const current=db.prepare('SELECT version,quote_completion_state FROM requests WHERE id=?').get(id) as any;if(!current)return {intent:'deleted',reply:'',terms:null,explicit_confirmation:false,terms_changed:false,purchase_acceptance:'unclear',phase};if(current.version!==startVersion||current.quote_completion_state!==startPhase)return {intent:'pending',reply:'Sua mensagem continua pendente enquanto atualizo a conversa.',terms:null,explicit_confirmation:false,terms_changed:false,purchase_acceptance:'unclear',phase,error_detail:'Estado da solicitação mudou durante o turno.'};
    const coreUnchanged=prior&&(!result?.terms||['unit_cents','shipping_cents','fees_cents','lead_days','available_qty','product_confirmed','destination_confirmed'].every(k=>result.terms[k]==null||result.terms[k]===(k.endsWith('_confirmed')?!!prior[k]:prior[k])));
    if(result.intent!=='pending'&&phase==='quote_confirmation'&&!input.reprocess&&(this.explicitYes(input.message)||(result.explicit_confirmation===true&&coreUnchanged))){result.explicit_confirmation=true;result.terms_changed=false;result.terms=priorPayload;}
    else if(result.intent!=='pending'&&(!['quote_completed','purchase'].includes(phase)||result.terms_changed||input.reprocess)){
      const persisted=this.persistDraft(id,input,result.terms,priorQuote);result.terms=persisted.terms;result.missing_fields=persisted.missing_fields;result.validation_errors=persisted.validation_errors;
      if(persisted.changed)result.terms_changed=true;
      if(phase!=='purchase'){
        if(!persisted.missing_fields.length&&(persisted.changed||result.explicit_confirmation!==true)){result.reply=persisted.reply;result.explicit_confirmation=false;}
        else if(persisted.missing_fields.length){result.explicit_confirmation=false;if(this.money(persisted.terms.unit_cents,false))result.reply=persisted.reply;}
      }
      if(phase==='purchase'&&persisted.changed){result.reply=`Os termos mudaram e a simulação precisa de nova revisão humana. ${persisted.reply}`;result.purchase_acceptance='unclear';}
    }
    if(!input.reprocess)db.prepare("INSERT OR IGNORE INTO conversation_messages(id,request_id,chat_id,sender_type,content,delivery_status,telegram_message_id,update_id,created_at) VALUES(?,?,?,'SUPPLIER',?,'received',?,?,?)").run(randomUUID(),id,input.chat_id||null,input.message,Number.isSafeInteger(input.telegram_message_id)?input.telegram_message_id:null,input.update_id??null,new Date().toISOString());return {...result,phase};}
  callback(taskId:string,body:any){const task=db.prepare('SELECT * FROM tasks WHERE id=?').get(taskId) as any;if(!task)throw new NotFoundException('Tarefa inexistente');const req=this.get(task.request_id);if(req.status==='decidida')return {ok:true,ignored:'decided'};if(req.status==='concluida')return {ok:true,ignored:'quote-completed'};if(task.status==='completed'||task.status==='failed')return {ok:true,duplicate:true};if(body?.execution_version!==req.execution_version)return {ok:true,ignored:'stale'};if(!body||!['completed','failed'].includes(body.status)||!Array.isArray(body.quotes)||body.quotes.length>100||body.quotes.some((q:any)=>!q.event_id))throw new BadRequestException('Callback requer estado e propostas com event_id estável.');const write=db.transaction(()=>{const fresh=db.prepare('SELECT status FROM tasks WHERE id=?').get(taskId) as any;if(fresh.status==='completed'||fresh.status==='failed')return;for(const q of body.quotes)this.addQuote(task.request_id,q);db.prepare("UPDATE tasks SET status=?,payload=? WHERE id=?").run(body.status==='failed'?'failed':'completed',JSON.stringify(body),taskId);db.prepare("UPDATE requests SET agent_analysis=?,notice=?,status=CASE WHEN status='pesquisando' THEN 'aguardando' ELSE status END,version=version+1 WHERE id=?").run(JSON.stringify({...(body.agent_notes||{}),...(body.discovery?{discovery:body.discovery}:{})}),this.latestTelegramNotice(task.request_id)||(body.status==='failed'?(body.error||'Pesquisa falhou; solicitação permanece pendente.'):null),task.request_id);});write();return {ok:true};}
  async telegram(body:any,secret:string,retry=false){
    const expected=process.env.TELEGRAM_WEBHOOK_SECRET||'',token=process.env.TELEGRAM_BOT_TOKEN||'',allowed=(process.env.TELEGRAM_ALLOWED_CHAT_IDS||'').split(',').map(x=>x.trim()).filter(Boolean);
    if(!expected||!token||!allowed.length||!secret||secret.length!==expected.length||!timingSafeEqual(Buffer.from(secret),Buffer.from(expected)))throw new UnauthorizedException();
    const updateId=body?.update_id,msg=body?.message;if(!Number.isSafeInteger(updateId)||!msg||typeof msg.text!=='string')return {ok:true,ignored:'unsupported'};
    const chat=String(msg.chat?.id??'');if(!allowed.includes(chat)||String(msg.from?.id??'')!==chat)return {ok:true,ignored:'unauthorized-chat'};
    const raw=msg.text.trim(),command=raw.split(/\s+/,1)[0].toLowerCase();
    const receivedAt=new Date().toISOString();
    const leaseUntil=new Date(Date.now()+40000).toISOString();
    if(!retry){
      const inserted=db.prepare("INSERT OR IGNORE INTO telegram_updates(update_id,received_at,raw_update,status,attempts,retry_after) VALUES(?,?,?,'processing',1,?)").run(updateId,new Date().toISOString(),JSON.stringify(body),leaseUntil);
      if(!inserted.changes){
        const prior=db.prepare('SELECT status,attempts,retry_after FROM telegram_updates WHERE update_id=?').get(updateId) as any;
        if(prior?.status==='processed'){
          const priorDel=db.prepare('SELECT id,message_text FROM telegram_delivery WHERE source_update_id=?').get(updateId) as any;
          if(!priorDel||!this.isPendingPlaceholder(priorDel.message_text))return {ok:true,duplicate:true};
          db.prepare('UPDATE telegram_delivery SET source_update_id=NULL WHERE id=?').run(priorDel.id);
          db.prepare("UPDATE telegram_updates SET status='processing',retry_after=? WHERE update_id=?").run(leaseUntil,updateId);
        }else if(this.activeUpdates.has(updateId)||(prior?.status==='processing'&&prior?.retry_after&&Date.parse(prior.retry_after)>Date.now())){
          return {ok:true,pending:true,reason:'already-processing'};
        }else{
          return {ok:true,pending:true,reason:'already-processing'};
        }
      }
    }
    this.activeUpdates.add(updateId);
    try{
      let savedDelivery=db.prepare('SELECT * FROM telegram_delivery WHERE source_update_id=?').get(updateId) as any;
      if(savedDelivery&&this.isPendingPlaceholder(savedDelivery.message_text)){
        db.prepare('UPDATE telegram_delivery SET source_update_id=NULL WHERE id=?').run(savedDelivery.id);
        savedDelivery=null;
      }
      if(savedDelivery){
        if(savedDelivery.status==='failed'){
          await this.retryTelegram(savedDelivery);
          const after=db.prepare('SELECT status FROM telegram_delivery WHERE id=?').get(savedDelivery.id) as any;
          db.prepare("UPDATE telegram_updates SET status=?,retry_after=? WHERE update_id=?").run(after.status==='sent'?'processed':'pending',after.status==='sent'?null:new Date(Date.now()+10000).toISOString(),updateId);
          return {ok:true,pending:after.status!=='sent',retried:true};
        }
        if(savedDelivery.status==='sending')db.prepare("UPDATE telegram_delivery SET status='uncertain',error=COALESCE(error,'Envio em andamento recuperado sem confirmação.') WHERE id=?").run(savedDelivery.id);
        db.prepare("UPDATE telegram_updates SET status='processed',retry_after=NULL WHERE update_id=?").run(updateId);
        return {ok:true,duplicate:true,uncertain:savedDelivery.status==='uncertain'||savedDelivery.status==='sending'};
      }
      if(['/start','/help','/test'].includes(command)){
        const text=command==='/test'?'Bot ativo. Este é o contato comercial da Nexo para receber cotações.':'Olá! Sou o assistente de compras da Nexo. Envie uma cotação em resposta à solicitação que recebeu. Se houver mais de uma solicitação aberta, responda à mensagem correspondente. No /test, confirmei que este contato comercial está ativo.';
        const id=randomUUID();
        db.prepare("INSERT INTO telegram_delivery(id,request_id,chat_id,status,error,created_at,message_text,source_update_id) VALUES(?,?,?,'sending',NULL,?,?,?)").run(id,'system',chat,new Date().toISOString(),text,updateId);
        const ok=await this.sendTelegram(id,'system',chat,text);
        db.prepare("UPDATE telegram_updates SET status=?,retry_after=? WHERE update_id=?").run(ok?'processed':'pending',ok?null:new Date(Date.now()+10000).toISOString(),updateId);
        return {ok:true,command};
      }
      const parent=msg.reply_to_message?.message_id;
      let mapping:any=Number.isSafeInteger(parent)?db.prepare('SELECT request_id FROM telegram_outbound WHERE chat_id=? AND message_id=?').get(chat,parent):null;
      if(Number.isSafeInteger(parent)&&!mapping){
        mapping=db.prepare("SELECT request_id FROM conversation_messages WHERE chat_id=? AND telegram_message_id=? AND channel='telegram' ORDER BY created_at DESC LIMIT 1").get(chat,parent)
          ||db.prepare("SELECT m.request_id FROM conversation_messages m JOIN telegram_updates u ON u.update_id=m.update_id WHERE m.chat_id=? AND m.channel='telegram' AND CAST(json_extract(u.raw_update,'$.message.message_id') AS INTEGER)=? ORDER BY m.created_at DESC LIMIT 1").get(chat,parent);
      }
      if(Number.isSafeInteger(parent)&&!mapping){db.prepare("UPDATE telegram_updates SET status='processed',retry_after=NULL WHERE update_id=?").run(updateId);return {ok:true,ignored:'unknown-reply'};}
      if(mapping?.request_id==='system')mapping=null;
      if(retry&&!mapping){
        const persisted=db.prepare("SELECT request_id FROM conversation_messages WHERE update_id=? AND channel='telegram' AND chat_id=?").get(updateId,chat) as any;
        if(persisted)mapping=persisted;
        else{
          const saved=db.prepare('SELECT received_at FROM telegram_updates WHERE update_id=?').get(updateId) as any;
          if(saved&&Date.now()-Date.parse(saved.received_at)>120000){
            this.markUpdateExhausted(updateId,'Mensagem antiga sem vínculo persistido; revisão manual necessária antes de atribuir uma solicitação.');
            return {ok:true,pending:true,reason:'unbound-historical-update'};
          }
        }
      }
      if(retry&&mapping&&db.prepare("SELECT 1 FROM conversation_messages m JOIN telegram_updates u ON u.update_id=m.update_id WHERE m.request_id=? AND m.chat_id=? AND m.channel='telegram' AND u.update_id>? AND u.status='processed' LIMIT 1").get(mapping.request_id,chat,updateId)){
        this.markUpdateExhausted(updateId,'Há mensagens posteriores já processadas nesta conversa; revisão manual necessária para evitar aplicar termos antigos.');
        return {ok:true,pending:true,reason:'superseded-update'};
      }
      if(!mapping){
        const activeSimSql=`EXISTS(SELECT 1 FROM purchase_simulations p JOIN purchase_outbox po ON po.simulation_id=p.id WHERE p.request_id=r.id AND p.status='awaiting_supplier' AND po.status IN ('queued','sending','sent'))`;
        let open=db.prepare(`SELECT DISTINCT r.id AS request_id FROM requests r JOIN telegram_outbound o ON o.request_id=r.id WHERE o.chat_id=? AND ((r.status NOT IN ('decidida','concluida') AND COALESCE(r.quote_completion_state,'coletando')<>'concluida') OR ${activeSimSql})`).all(chat) as any[];
        if(!open.length){
          open=db.prepare(`SELECT DISTINCT r.id AS request_id FROM requests r JOIN telegram_outbound o ON o.request_id=r.id WHERE o.chat_id=? AND (r.status NOT IN ('decidida','concluida') OR ${activeSimSql})`).all(chat) as any[];
        }
        if(open.length!==1){
          const prompt=open.length?'Tenho mais de uma solicitação ativa. Responda à mensagem da cotação que deseja tratar, por favor.':'Não encontrei uma solicitação ativa para esta conversa.';
          const did=randomUUID();
          db.prepare("INSERT INTO telegram_delivery(id,request_id,chat_id,status,created_at,message_text,source_update_id) VALUES(?,'system',?,'sending',?,?,?)").run(did,chat,new Date().toISOString(),prompt,updateId);
          const sentPrompt=await this.sendTelegram(did,'system',chat,prompt);
          db.prepare("UPDATE telegram_updates SET status=?,retry_after=? WHERE update_id=?").run(sentPrompt?'processed':'pending',sentPrompt?null:new Date(Date.now()+10000).toISOString(),updateId);
          return {ok:true,ambiguous:open.length>1};
        }
        mapping=open[0];
      }
      const reqId=String(mapping.request_id);
      this.get(reqId);
      const flow=db.prepare('SELECT supplier_id FROM whatsapp_contact_flow WHERE request_id=?').get(reqId) as any;
      const fallbackStarted=!!db.prepare("SELECT 1 FROM telegram_delivery WHERE id=? AND status IN ('sending','sent','uncertain','failed')").get(`wa-fallback:${reqId}`);
      if(flow){
        const existingWinner=db.prepare('SELECT channel FROM supplier_response_winner WHERE request_id=?').get(reqId) as any;
        if(existingWinner?.channel==='whatsapp'){
          db.prepare("UPDATE telegram_updates SET status='processed',retry_after=NULL,error='other-channel-won' WHERE update_id=?").run(updateId);
          console.warn(JSON.stringify({event:'supplier_reply_ignored',channel:'telegram',reason:'other-channel-won'}));
          return {ok:true,ignored:'other-channel-won'};
        }
        if(!fallbackStarted){
          db.prepare("UPDATE telegram_updates SET status='processed',retry_after=NULL,error='whatsapp-priority-window' WHERE update_id=?").run(updateId);
          console.warn(JSON.stringify({event:'supplier_reply_ignored',channel:'telegram',reason:'whatsapp-priority-window'}));
          return {ok:true,ignored:'whatsapp-priority-window'};
        }
        const claim=this.whatsapp.claimResponseChannel(reqId,String(flow.supplier_id),'telegram',receivedAt,String(updateId));
        if(!claim.allowed){
          db.prepare("UPDATE telegram_updates SET status='processed',retry_after=NULL,error=? WHERE update_id=?").run(claim.reason,updateId);
          console.warn(JSON.stringify({event:'supplier_reply_ignored',channel:'telegram',reason:claim.reason}));
          return {ok:true,ignored:claim.reason};
        }
      }
      db.prepare("INSERT OR IGNORE INTO conversation_messages(id,request_id,chat_id,sender_type,content,delivery_status,telegram_message_id,update_id,created_at) VALUES(?,?,?,'SUPPLIER',?,'received',?,?,?)").run(randomUUID(),reqId,chat,raw,Number.isSafeInteger(msg.message_id)?msg.message_id:null,updateId,new Date().toISOString());
      return await this.withTurnLock(reqId,async()=>{
        if(!this.exists(reqId))return {ok:true,ignored:'deleted'};
        const req=this.get(reqId);
        const simBefore=this.purchaseSimulationRow(req.id) as any;
        const orderReply=simBefore?.status==='awaiting_supplier'&&Number.isSafeInteger(parent)&&!!db.prepare("SELECT 1 FROM purchase_outbox o JOIN telegram_delivery d ON d.id=o.delivery_id JOIN telegram_outbound t ON t.request_id=o.request_id AND t.chat_id=o.chat_id AND CAST(t.message_id AS INTEGER)=? WHERE d.telegram_message_id=? AND o.delivery_id=d.id AND o.simulation_id=? AND o.chat_id=? AND o.status='sent' AND d.status='sent' AND d.chat_id=?").get(parent,parent,simBefore.id,chat,chat);
        const quoteWasAwaiting=req.quote_completion_state==='aguardando_confirmacao';
        const result=await this.conversationTurnUnlocked(req.id,{message:raw,chat_id:chat,update_id:updateId,telegram_message_id:msg.message_id,supplier_name:msg.from?.first_name});
        if(!this.exists(req.id)||result.intent==='deleted')return {ok:true,ignored:'deleted'};
        if(result.intent==='pending'){
          const errDetail=this.sanitizeError(result.error_detail||result.error_code||'Interpretação temporariamente pendente.');
          const updRow=db.prepare('SELECT attempts FROM telegram_updates WHERE update_id=?').get(updateId) as any;
          if((updRow?.attempts||1)>=3){
            this.markUpdateExhausted(updateId,errDetail);
          }else{
            db.prepare("UPDATE telegram_updates SET status='pending',retry_after=?,error=? WHERE update_id=?").run(new Date(Date.now()+10000).toISOString(),errDetail,updateId);
            db.prepare('UPDATE requests SET notice=COALESCE(notice,?) WHERE id=?').run('Mensagem do fornecedor recebida; interpretação pendente para nova tentativa automática.',req.id);
          }
          return {ok:true,pending:true,reason:'interpretation-pending'};
        }
        const afterTurn=db.prepare('SELECT quote_completion_state,quote_terms_snapshot,completed_quote_id FROM requests WHERE id=?').get(req.id) as any;
        if(result.explicit_confirmation===true&&(quoteWasAwaiting||req.quote_completion_state==='coletando')&&afterTurn.quote_completion_state!=='concluida'){
          const latest=db.prepare(`SELECT q.* FROM quotes q WHERE q.request_id=? AND
            (q.supplier_chat_id=? OR (q.supplier_chat_id IS NULL AND EXISTS (
              SELECT 1 FROM telegram_updates u WHERE q.event_id='telegram:'||u.update_id
              AND CAST(json_extract(u.raw_update,'$.message.chat.id') AS TEXT)=?)))
            ORDER BY q.created_at DESC,q.rowid DESC LIMIT 1`).get(req.id,chat,chat) as any;
          const missing:string[]=[];
          if(!latest?.supplier?.trim())missing.push('fornecedor');
          if(!this.money(latest?.unit_cents,false))missing.push('preço unitário');
          if(!this.money(latest?.shipping_cents,true))missing.push('frete');
          if(!this.money(latest?.fees_cents,true))missing.push('taxas');
          if(!Number.isInteger(latest?.lead_days)||latest.lead_days<0||latest.lead_days>3650)missing.push('prazo de entrega');
          if(!Number.isInteger(latest?.available_qty)||latest.available_qty<req.qty)missing.push('disponibilidade para a quantidade solicitada');
          if(!latest?.product_confirmed)missing.push('confirmação do produto solicitado');
          if(!latest?.destination_confirmed)missing.push('confirmação do destino de entrega');
          if(latest&&!Number.isSafeInteger(latest.unit_cents*req.qty+latest.shipping_cents+latest.fees_cents))missing.push('valores que permitam calcular um total seguro');
          if(!missing.length&&this.sameSnapshot(latest,afterTurn.quote_terms_snapshot)&&afterTurn.quote_completion_state==='aguardando_confirmacao'){
            const final=await this.completeQuote(req.id,chat,`${latest.supplier}; preço unitário R$ ${(latest.unit_cents/100).toFixed(2)}, frete R$ ${(latest.shipping_cents/100).toFixed(2)}, taxas R$ ${(latest.fees_cents/100).toFixed(2)}, prazo ${latest.lead_days} dias, disponibilidade ${latest.available_qty} unidades.`,updateId);
            if(final.completed){db.prepare("UPDATE telegram_updates SET status=?,retry_after=?,error=NULL WHERE update_id=?").run(final.pending?'pending':'processed',final.pending?new Date(Date.now()+10000).toISOString():null,updateId);return final;}
          }
          result.explicit_confirmation=false;
          if(!missing.length){
            db.prepare("UPDATE requests SET quote_completion_state='aguardando_confirmacao',quote_terms_snapshot=?,completed_quote_id=NULL,version=version+1 WHERE id=?").run(this.termsSnapshot(latest),req.id);
            result.reply=`Anotei os termos atualizados: ${latest.supplier}, preço unitário R$ ${(latest.unit_cents/100).toFixed(2)}, frete R$ ${(latest.shipping_cents/100).toFixed(2)}, taxas R$ ${(latest.fees_cents/100).toFixed(2)}, prazo ${latest.lead_days} dias e disponibilidade ${latest.available_qty} unidades. Confirma essas condições?`;
          }else{
            db.prepare("UPDATE requests SET quote_completion_state='coletando',quote_terms_snapshot=NULL,completed_quote_id=NULL,version=version+1 WHERE id=?").run(req.id);
            result.reply=`Ainda preciso de ${missing.join(', ')} para confirmar a cotação. Pode me informar?`;
          }
        }
        const sim=this.purchaseSimulationRow(req.id) as any;
        if(sim&&sim.status==='awaiting_supplier'&&orderReply&&result.purchase_acceptance==='accepted'&&sim.quote_id===req.completed_quote_id&&sim.snapshot===req.quote_terms_snapshot)db.prepare("UPDATE purchase_simulations SET status='confirmed' WHERE id=? AND status='awaiting_supplier' AND quote_id=? AND snapshot=?").run(sim.id,req.completed_quote_id,req.quote_terms_snapshot);
        else if(sim&&sim.status==='awaiting_supplier'&&orderReply&&result.purchase_acceptance==='rejected')db.prepare("UPDATE purchase_simulations SET status='rejected' WHERE id=? AND status='awaiting_supplier'").run(sim.id);
        else if(result.purchase_acceptance==='accepted'&&!orderReply){result.purchase_acceptance='unclear';result.reply='Para confirmar a simulação, responda à mensagem do pedido simulado mais recente enviada por este chat.';}
        let delivery=db.prepare('SELECT * FROM telegram_delivery WHERE source_update_id=?').get(updateId) as any;
        let sent=true;
        if(!delivery){
          const did=randomUUID();
          db.prepare("INSERT OR IGNORE INTO telegram_delivery(id,request_id,chat_id,status,created_at,message_text,source_update_id) VALUES(?,?,?,'sending',?,?,?)").run(did,req.id,chat,new Date().toISOString(),result.reply,updateId);
          delivery=db.prepare('SELECT * FROM telegram_delivery WHERE source_update_id=?').get(updateId) as any;
          if(delivery?.id===did)sent=!!(await this.sendTelegram(did,req.id,chat,result.reply));
        }
        db.prepare("UPDATE telegram_updates SET status=?,retry_after=?,error=CASE WHEN ? THEN NULL ELSE error END WHERE update_id=?").run(!sent?'pending':'processed',!sent?new Date(Date.now()+10000).toISOString():null,sent?1:0,updateId);
        return {ok:true,pending:!sent};
      });
    }catch(err){
      const diag=this.sanitizeError(err);
      const updRow=db.prepare('SELECT attempts FROM telegram_updates WHERE update_id=?').get(updateId) as any;
      if((updRow?.attempts||1)>=3){
        this.markUpdateExhausted(updateId,diag);
      }else{
        db.prepare("UPDATE telegram_updates SET status='pending',retry_after=?,error=? WHERE update_id=?").run(new Date(Date.now()+10000).toISOString(),diag,updateId);
      }
      return {ok:true,pending:true,reason:'conversation-turn-unavailable'};
    }finally{
      this.activeUpdates.delete(updateId);
    }
  }
  private publicUser(row: any) {
    return { id: row.id, name: row.name, email: row.email, google_id: row.google_id || null, avatar_url: row.avatar_url || null, created_at: row.created_at };
  }
  getAuthConfig() {
    const dbClientId = (db.prepare("SELECT value FROM app_settings WHERE key = 'google_client_id'").get() as any)?.value || '';
    const dbClientSecret = (db.prepare("SELECT value FROM app_settings WHERE key = 'google_client_secret'").get() as any)?.value || '';
    const envClientId = (process.env.GOOGLE_CLIENT_ID || process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID || '').trim();
    const envClientSecret = (process.env.GOOGLE_CLIENT_SECRET || '').trim();
    const clientId = (dbClientId || envClientId).trim() || null;
    const hasSecret = Boolean((dbClientSecret || envClientSecret).trim());
    return { google_client_id: clientId, has_client_secret: hasSecret };
  }
  saveAuthConfig(body: any) {
    const rawClientId = typeof body?.google_client_id === 'string' ? body.google_client_id.trim() : '';
    const rawClientSecret = typeof body?.google_client_secret === 'string' ? body.google_client_secret.trim() : '';
    if (!rawClientId || !rawClientId.endsWith('.apps.googleusercontent.com')) {
      throw new BadRequestException('Informe um Google Client ID válido (terminado em .apps.googleusercontent.com).');
    }
    const now = new Date().toISOString();
    db.prepare("INSERT INTO app_settings(key, value, updated_at) VALUES ('google_client_id', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at").run(rawClientId, now);
    if (rawClientSecret) {
      db.prepare("INSERT INTO app_settings(key, value, updated_at) VALUES ('google_client_secret', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at").run(rawClientSecret, now);
    }
    return this.getAuthConfig();
  }
  register(body: any) {
    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
    const password = typeof body?.password === 'string' ? body.password : '';
    if (name.length < 2 || name.length > 120) throw new BadRequestException('Informe um nome válido (entre 2 e 120 caracteres).');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) throw new BadRequestException('Informe um e-mail corporativo válido.');
    if (password.length < 6 || password.length > 128) throw new BadRequestException('A senha deve ter entre 6 e 128 caracteres.');
    const exists = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
    if (exists) throw new BadRequestException('Este e-mail já está cadastrado. Faça login.');
    const id = randomUUID(), now = new Date().toISOString(), passwordHash = hashPassword(password);
    db.prepare('INSERT INTO users(id, name, email, password_hash, google_id, avatar_url, created_at) VALUES (?, ?, ?, ?, NULL, NULL, ?)').run(id, name, email, passwordHash, now);
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id) as any;
    const token = signJwt({ sub: user.id, email: user.email, name: user.name });
    return { token, user: this.publicUser(user) };
  }
  login(body: any) {
    const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
    const password = typeof body?.password === 'string' ? body.password : '';
    if (!email || !password) throw new BadRequestException('Informe seu e-mail e senha.');
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email) as any;
    if (!user) throw new UnauthorizedException('E-mail ou senha inválidos.');
    if (!user.password_hash) throw new UnauthorizedException('Esta conta utiliza login com Google. Clique em "Continuar com o Google".');
    if (!verifyPassword(password, user.password_hash)) throw new UnauthorizedException('E-mail ou senha inválidos.');
    const token = signJwt({ sub: user.id, email: user.email, name: user.name });
    return { token, user: this.publicUser(user) };
  }
  async googleAuth(body: any): Promise<{ token: string; user: any }> {
    let googleId = '', email = '', name = '', avatarUrl: string | null = null;
    const dbClientId = (db.prepare("SELECT value FROM app_settings WHERE key = 'google_client_id'").get() as any)?.value || '';
    const dbClientSecret = (db.prepare("SELECT value FROM app_settings WHERE key = 'google_client_secret'").get() as any)?.value || '';
    const clientId = (dbClientId || process.env.GOOGLE_CLIENT_ID || process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID || '').trim();
    const clientSecret = (dbClientSecret || process.env.GOOGLE_CLIENT_SECRET || '').trim();
    if (typeof body?.credential === 'string' && body.credential.trim()) {
      const res = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(body.credential.trim())}`, { signal: AbortSignal.timeout(10000) });
      if (!res.ok) throw new UnauthorizedException('Credencial do Google inválida ou expirada.');
      const info: any = await res.json();
      if (clientId && info.aud && info.aud !== clientId) throw new UnauthorizedException('Client ID do Google não corresponde a esta aplicação.');
      if (!info.email || !info.sub) throw new UnauthorizedException('Token do Google não contém perfil válido.');
      googleId = String(info.sub);
      email = String(info.email).toLowerCase();
      name = String(info.name || info.given_name || email.split('@')[0]).slice(0, 120);
      avatarUrl = typeof info.picture === 'string' ? info.picture : null;
    } else if (typeof body?.access_token === 'string' && body.access_token.trim()) {
      const res = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', { headers: { Authorization: `Bearer ${body.access_token.trim()}` }, signal: AbortSignal.timeout(10000) });
      if (!res.ok) throw new UnauthorizedException('Token de acesso do Google inválido ou expirado.');
      const info: any = await res.json();
      if (!info.email || !info.sub) throw new UnauthorizedException('Perfil do Google incompleto.');
      googleId = String(info.sub);
      email = String(info.email).toLowerCase();
      name = String(info.name || info.given_name || email.split('@')[0]).slice(0, 120);
      avatarUrl = typeof info.picture === 'string' ? info.picture : null;
    } else if (typeof body?.code === 'string' && body.code.trim()) {
      if (!clientId || !clientSecret) throw new BadRequestException('GOOGLE_CLIENT_ID e GOOGLE_CLIENT_SECRET não configurados no servidor.');
      const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ code: body.code.trim(), client_id: clientId, client_secret: clientSecret, redirect_uri: body.redirect_uri || 'postmessage', grant_type: 'authorization_code' }),
        signal: AbortSignal.timeout(10000),
      });
      if (!tokenRes.ok) throw new UnauthorizedException('Falha ao trocar código OAuth com o Google.');
      const tokens: any = await tokenRes.json();
      return this.googleAuth({ credential: tokens.id_token, access_token: tokens.access_token });
    } else {
      throw new BadRequestException('Credencial OAuth do Google ausente. Configure o Google Client ID para autenticar com o Google.');
    }
    let user = db.prepare('SELECT * FROM users WHERE google_id = ? OR email = ?').get(googleId, email) as any;
    if (user) {
      db.prepare("UPDATE users SET google_id = COALESCE(?, google_id), avatar_url = COALESCE(?, avatar_url), name = COALESCE(NULLIF(?, ''), name) WHERE id = ?").run(googleId, avatarUrl, name, user.id);
      user = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id) as any;
    } else {
      const id = randomUUID(), now = new Date().toISOString();
      db.prepare('INSERT INTO users(id, name, email, password_hash, google_id, avatar_url, created_at) VALUES (?, ?, ?, NULL, ?, ?, ?)').run(id, name, email, googleId, avatarUrl, now);
      user = db.prepare('SELECT * FROM users WHERE id = ?').get(id) as any;
    }
    const token = signJwt({ sub: user.id, email: user.email, name: user.name });
    return { token, user: this.publicUser(user) };
  }
  me(authHeader?: string) {
    const token = (authHeader || '').replace(/^Bearer\s+/i, '').trim();
    if (!token) throw new UnauthorizedException('Não autenticado.');
    const payload = verifyJwt(token);
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(payload.sub) as any;
    if (!user) throw new UnauthorizedException('Sessão inválida.');
    return { user: this.publicUser(user) };
  }
}
@Controller() class Routes {
  constructor(@Inject(Business) private readonly b: Business) {}
  private searchOriginAllowed(origin?:string) {
    if(!origin)return false;
    let parsed:URL;try{parsed=new URL(origin);}catch{return false;}
    if(parsed.origin!==origin||parsed.username||parsed.password)return false;
    const allowed=new Set(['http://localhost:3000','http://127.0.0.1:3000',...(process.env.CORS_ORIGINS||'').split(',').map(value=>value.trim()).filter(Boolean)]);
    return allowed.has(origin);
  }
  private async searchIntegration(method:'GET'|'POST',origin?:string,settingsHeader?:string,body?:any) {
    if(origin&&!this.searchOriginAllowed(origin))throw new BadRequestException('Origem inválida.');
    if(method==='POST'&&(settingsHeader!=='1'||!this.searchOriginAllowed(origin)))throw new BadRequestException('Configure a integração pela página local da aplicação.');
    const token=process.env.INTERNAL_API_TOKEN||'';
    if(!token)throw new HttpException({detail:'Integração de busca temporariamente indisponível.'},503);
    try {
      const response=await fetch(`${process.env.AGENT_URL||'http://agents:8000'}/integrations/search`,{method,headers:{'content-type':'application/json','authorization':`Bearer ${token}`,...(origin?{origin}:{}),...(method==='POST'?{'x-nexo-settings':settingsHeader||''}:{})},...(method==='POST'?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(25000)});
      const text=await response.text();let payload:any;try{payload=JSON.parse(text);}catch{throw new HttpException({detail:'Resposta inválida do serviço de busca.'},502);}
      const sanitize=(value:any):any=>{
        if(typeof value==='string')return value.replace(/(?:tvly-|gsk_|AIza)[A-Za-z0-9_-]+/g,'[REDACTED]').replace(/Bearer\s+[A-Za-z0-9._-]+/gi,'Bearer [REDACTED]').slice(0,1000);
        if(Array.isArray(value))return value.slice(0,50).map(sanitize);
        if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([key])=>!/(?:api_?key|token|secret|authorization)/i.test(key)).map(([key,item])=>[key,sanitize(item)]));
        return value;
      };
      if(!response.ok)throw new HttpException(sanitize(payload),response.status);
      return sanitize(payload);
    } catch(error) {
      if(error instanceof HttpException)throw error;
      throw new HttpException({detail:'Serviço de busca temporariamente indisponível.'},503);
    }
  }
  @Get('integrations/search') searchStatus(@Headers('origin') origin?:string){return this.searchIntegration('GET',origin);}
  @Post('integrations/search') @HttpCode(200) connectSearch(@Headers('origin') origin?:string,@Headers('x-nexo-settings') settingsHeader?:string,@Body() body?:any){return this.searchIntegration('POST',origin,settingsHeader,body);}
  @Get('health') health(){return {status:'ok',service:'nest-business-api'};}
  @Get('auth/config') getAuthConfig(){return this.b.getAuthConfig();}
  @Post('auth/config') @HttpCode(200) saveAuthConfig(@Body() body:any){return this.b.saveAuthConfig(body);}
  @Post('auth/register') register(@Body() body:any){return this.b.register(body);}
  @Post('auth/login') @HttpCode(200) login(@Body() body:any){return this.b.login(body);}
  @Post('auth/google') @HttpCode(200) google(@Body() body:any){return this.b.googleAuth(body);}
  @Get('auth/me') me(@Headers('authorization') auth?:string){return this.b.me(auth);}
  @Get('history') history(@Query() query:Record<string,unknown>){return this.b.history.list(query);}
  @Get('history/:id') historyDetail(@Param('id') id:string){return this.b.history.detail(id);}
  @Get('requests') list(){return this.b.list();}
  @Post('requests') create(@Body() body:any){return this.b.create(body);}
  @Delete('requests/:id') @HttpCode(200) remove(@Param('id') id:string){return this.b.remove(id);}
  @Post('requests/:id/repeat') repeat(@Param('id') id:string,@Body() body:any){return this.b.repeat(id,body);}
  @Get('requests/:id') detail(@Param('id') id:string){return this.b.get(id);}
  @Get('procurement/:id/price-history') priceHistory(@Param('id') id:string,@Query('days') days?:string,@Query('source_url') sourceUrl?:string){return this.b.priceHistory(id,days,sourceUrl);}
  @Get('requests/:id/messages') messages(@Param('id') id:string){return this.b.messages(id);}
  @Post('requests/:id/contact-supplier') contact(@Param('id') id:string,@Headers('idempotency-key') key?:string,@Body() body?:any){return this.b.contactSupplier(id,key,body?.supplier_id);}
  /** Fluxo duplex: (1) liga via Vapi → (2) follow-up Telegram automático pós-chamada */
  @Post('requests/:id/call-supplier') callSupplier(@Param('id') id:string,@Body() body:any){return this.b.callSupplier(id,body);}
  @Post('requests/:id/quotes') quote(@Param('id') id:string,@Body() body:any){return this.b.addQuote(id,body);}
  @Post('requests/:id/decision') decision(@Param('id') id:string,@Body() body:any,@Headers('idempotency-key') key?:string){return this.b.decide(id,body,key);}
  @Post('requests/:id/purchase-recommendation') purchaseRecommendation(@Param('id') id:string,@Body() body:any){return this.b.purchaseRecommendation(id,body);}
  @Post('requests/:id/purchase-recommendation/approval') approvePurchaseRecommendation(@Param('id') id:string,@Body() body:any){return this.b.approvePurchaseRecommendation(id,body);}
  @Post('requests/:id/market-preference') marketPreference(@Param('id') id:string,@Body() body:any){return this.b.marketPreference(id,body);}
  @Get('requests/:id/purchase-simulation') purchaseSimulation(@Param('id') id:string){return this.b.purchaseSimulation(id);}
  @Post('requests/:id/purchase-simulation/cancel') cancelPurchase(@Param('id') id:string){return this.b.cancelPurchase(id);}
  @Post('requests/:id/reputation-refresh') reputation(@Param('id') id:string){return this.b.refreshReputation(id);}
  @Post('requests/:id/conversation-turn') conversation(@Param('id') id:string,@Body() body:any){return this.b.conversationTurn(id,{message:body?.message,chat_id:body?.chat_id});}
  @Post('requests/:id/reprocess-conversation') @HttpCode(200) reprocess(@Param('id') id:string,@Body() body:any,@Headers('authorization') auth:string,@Headers('idempotency-key') key?:string){this.agentAuth(auth);return this.b.reprocessConversation(id,body,key);}
  @Post('requests/:id/recover-quotation') @HttpCode(200) recoverQuotation(@Param('id') id:string,@Body() body:any,@Headers('authorization') auth:string,@Headers('idempotency-key') key?:string){this.agentAuth(auth);if(!key||key.length>160)throw new BadRequestException('Idempotency-Key obrigatória para recuperar a cotação.');return this.b.reprocessConversation(id,{...body,send:true},key);}
  @Post('requests/:id/reconcile-confirmation') @HttpCode(200) reconcile(@Param('id') id:string,@Headers('authorization') auth:string){this.agentAuth(auth);return this.b.reconcileConfirmation(id);}
  @Post('tasks/:id/result') @HttpCode(200) result(@Param('id') id:string,@Body() body:any,@Headers('authorization') auth:string){this.agentAuth(auth);return this.b.callback(id,body);}
  private agentAuth(auth:string){const expected=process.env.INTERNAL_API_TOKEN||'',received=(auth||'').replace(/^Bearer\s+/i,'');if(!expected||!received||received.length!==expected.length||!timingSafeEqual(Buffer.from(received),Buffer.from(expected)))throw new UnauthorizedException('Agente interno não autenticado');}
  @Post('requests/:id/whatsapp') registerWhatsApp(@Param('id') id:string,@Body() body:any,@Headers('authorization') auth:string){this.agentAuth(auth);return this.b.whatsapp.register(id,body);}
  @Post('webhook/voice') @HttpCode(200) voice(@Body() body:any,@Headers('x-voice-webhook-secret') secret:string){webhookAuth(secret,process.env.VOICE_WEBHOOK_SECRET||'');return this.b.whatsapp.voice(body);}
  @Post('webhook/whatsapp') @HttpCode(200) whatsapp(@Body() body:any,@Headers('x-whatsapp-webhook-secret') secret:string){return this.b.whatsapp.webhook(body,secret);}
  @Post('webhook/telegram') @HttpCode(200) telegram(@Body() body:any,@Headers('x-telegram-bot-api-secret-token') secret:string){return this.b.telegram(body,secret);}
}
@Module({controllers:[Routes],providers:[Business]}) class AppModule {}
async function main(){const app=await NestFactory.create(AppModule); app.enableCors({origin:true}); await app.listen(Number(process.env.PORT||4000),process.env.HOST||'0.0.0.0');}
void main();
