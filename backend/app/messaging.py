import hashlib
import secrets
import logging
from datetime import datetime, timedelta, timezone

import httpx
from fastapi import APIRouter, Header, HTTPException, Request
from pydantic import BaseModel, Field, ConfigDict
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from starlette.concurrency import run_in_threadpool

from .config import settings, personal_telegram_chat_id
from .database import SessionLocal, SupplierMemory, ChatMessage, TelegramUpdate, AgentJob
from .orchestrator import MarketRun, PurchaseRead
from .scraper_tools import domain, timestamp


for logger_name in ('httpx', 'httpx2', 'httpcore', 'httpcore2'):
    logging.getLogger(logger_name).setLevel(logging.WARNING)


class MessagingError(Exception):
    pass


async def telegram(method: str, payload: dict) -> dict:
    if not settings.telegram_bot_token:
        raise MessagingError('TELEGRAM_BOT_TOKEN não configurado.')
    token = settings.telegram_bot_token.get_secret_value()
    try:
        async with httpx.AsyncClient(timeout=15, follow_redirects=False) as client:
            response = await client.post(f'https://api.telegram.org/bot{token}/{method}', json=payload)
            body = response.json()
        if not isinstance(body, dict) or response.status_code != 200 or body.get('ok') is not True:
            raise MessagingError(f'Telegram recusou a operação (HTTP {response.status_code}).')
        if method == 'sendMessage' and (not isinstance(body.get('result'), dict) or type(body['result'].get('message_id')) is not int or body['result']['message_id'] <= 0):
            raise MessagingError('Telegram retornou uma confirmação de envio inválida.')
        return body['result']
    except (httpx.HTTPError, ValueError, KeyError):
        raise MessagingError('Não foi possível confirmar a operação no Telegram; não será reenviada automaticamente.') from None


def prepare_message(request_id: int, supplier_domain: str, text: str, action_key: str):
    with SessionLocal.begin() as db:
        run = db.get(MarketRun, request_id)
        if not run:
            raise MessagingError('Solicitação não encontrada.')
        purchase = PurchaseRead.model_validate_json(run.snapshot)
        if purchase.mode == 'sandbox':
            try:
                destination = personal_telegram_chat_id()
            except ValueError as exc:
                raise MessagingError(str(exc)) from None
            previous = db.scalar(select(ChatMessage).where(ChatMessage.request_id == request_id, ChatMessage.sender_type.in_(['AI', 'ai'])).order_by(ChatMessage.id))
            if previous and previous.chat_id != destination:
                raise MessagingError('O chat pessoal foi alterado durante esta demonstração. Inicie um novo teste.')
        else:
            contact = db.get(SupplierMemory, supplier_domain)
            if not contact or contact.chat_id is None or not contact.authorized_at:
                raise MessagingError('Fornecedor sem contato Telegram autorizado.')
            destination = contact.chat_id
        old = db.scalar(select(ChatMessage).where(ChatMessage.action_key == action_key))
        if old:
            return old.id, old.chat_id, old.delivery_status, False
        row = ChatMessage(request_id=request_id, supplier_domain=supplier_domain, chat_id=destination, sender_type='AI', text=text, timestamp=timestamp(), action_key=action_key, delivery_status='sending')
        db.add(row)
        db.flush()
        return row.id, row.chat_id, row.delivery_status, True


async def send_telegram_message(request_id: int, supplier_domain: str, text: str, action_key: str):
    message_id, chat_id, status, created = await run_in_threadpool(prepare_message, request_id, supplier_domain, text, action_key)
    if not created:
        if status == 'sent':
            return
        raise MessagingError('Envio anterior não confirmado. Verifique a conversa antes de retomar.')
    def persisted_text():
        with SessionLocal() as db:
            return db.get(ChatMessage, message_id).text
    text = await run_in_threadpool(persisted_text)
    try:
        result = await telegram('sendMessage', {'chat_id': chat_id, 'text': text[:4096], 'reply_markup': {'force_reply': True, 'selective': True}})
        def delivered():
            with SessionLocal.begin() as db:
                row = db.get(ChatMessage, message_id)
                row.telegram_message_id = result['message_id']
                row.delivery_status = 'sent'
        await run_in_threadpool(delivered)
    except Exception:
        def uncertain():
            with SessionLocal.begin() as db:
                db.get(ChatMessage, message_id).delivery_status = 'unconfirmed'
        await run_in_threadpool(uncertain)
        raise


send_message = send_telegram_message


class Chat(BaseModel):
    id: int = Field(strict=True)
    type: str


class Reply(BaseModel):
    message_id: int = Field(gt=0, strict=True)


class IncomingMessage(Reply):
    chat: Chat
    text: str | None = Field(default=None, max_length=4096)
    reply_to_message: Reply | None = None


class IncomingUpdate(BaseModel):
    update_id: int = Field(ge=0, strict=True)
    message: IncomingMessage | None = None


def receive(update: IncomingUpdate):
    try:
        with SessionLocal.begin() as db:
            if db.get(TelegramUpdate, update.update_id):
                return {'ok': True, 'duplicate': True}
            receipt = TelegramUpdate(id=update.update_id, processed=True)
            db.add(receipt)
            msg = update.message
            if not msg or not msg.text or msg.chat.type != 'private':
                return {'ok': True, 'ignored': True}
            if msg.text.startswith('/start '):
                token = msg.text.split(' ', 1)[1].strip()
                contact = db.scalar(select(SupplierMemory).where(SupplierMemory.invite_hash == hashlib.sha256(token.encode()).hexdigest()))
                if contact and contact.invite_expires and contact.invite_expires > timestamp() and contact.chat_id is None:
                    existing = db.scalar(select(SupplierMemory).where(SupplierMemory.chat_id == msg.chat.id))
                    if existing:
                        return {'ok': True, 'ignored': True}
                    contact.chat_id = msg.chat.id
                    contact.authorized_at = timestamp()
                    contact.invite_hash = contact.invite_expires = None
                return {'ok': True}
            contact = db.scalar(select(SupplierMemory).where(SupplierMemory.chat_id == msg.chat.id, SupplierMemory.authorized_at.is_not(None)))
            try:
                is_personal = msg.chat.id == personal_telegram_chat_id()
            except ValueError:
                is_personal = False
            outgoing = None
            if msg.reply_to_message:
                outgoing = db.scalar(select(ChatMessage).where(ChatMessage.chat_id == msg.chat.id, ChatMessage.telegram_message_id == msg.reply_to_message.message_id, ChatMessage.sender_type.in_(['AI', 'ai']), ChatMessage.delivery_status == 'sent'))
            elif is_personal:
                active = {}
                messages = db.scalars(select(ChatMessage).join(AgentJob, ChatMessage.request_id == AgentJob.request_id).where(ChatMessage.chat_id == msg.chat.id, ChatMessage.sender_type.in_(['AI', 'ai']), ChatMessage.delivery_status == 'sent', AgentJob.status.in_(['waiting', 'pending', 'running'])).order_by(ChatMessage.id.desc()))
                for message in messages:
                    request = PurchaseRead.model_validate_json(db.get(MarketRun, message.request_id).snapshot)
                    current_job = db.get(AgentJob, message.request_id)
                    if request.mode == 'sandbox' and message.action_key and message.action_key.startswith(f'{message.request_id}:{current_job.generation}:'):
                        active.setdefault((message.request_id, message.supplier_domain), message)
                        if len(active) > 1:
                            break
                if len(active) == 1:
                    outgoing = next(iter(active.values()))
            if not outgoing:
                sending = db.scalar(select(ChatMessage.id).where(ChatMessage.chat_id == msg.chat.id, ChatMessage.delivery_status == 'sending').limit(1))
                if sending and (contact or is_personal):
                    raise HTTPException(503, 'Envio ainda em confirmação; Telegram deve repetir esta atualização.')
                return {'ok': True, 'ignored': True, 'reason': 'Responda diretamente à mensagem da negociação; pode haver mais de um teste ativo.'}
            purchase = PurchaseRead.model_validate_json(db.get(MarketRun, outgoing.request_id).snapshot)
            if purchase.mode == 'sandbox':
                if not is_personal:
                    return {'ok': True, 'ignored': True}
            elif not contact or outgoing.supplier_domain != contact.domain:
                return {'ok': True, 'ignored': True}
            job = db.get(AgentJob, outgoing.request_id)
            if purchase.status == 'DONE' or not job or job.status == 'finished':
                return {'ok': True, 'ignored': True, 'reason': 'Negociação encerrada.'}
            if job and outgoing.action_key and not outgoing.action_key.startswith(f'{outgoing.request_id}:{job.generation}:'):
                return {'ok': True, 'ignored': True}
            old_message = db.scalar(select(ChatMessage).where(ChatMessage.chat_id == msg.chat.id, ChatMessage.telegram_message_id == msg.message_id))
            if old_message:
                return {'ok': True, 'duplicate': True}
            newer = db.scalar(select(ChatMessage.id).where(ChatMessage.request_id == outgoing.request_id, ChatMessage.supplier_domain == outgoing.supplier_domain, ChatMessage.chat_id == msg.chat.id, ChatMessage.sender_type == 'SUPPLIER', ChatMessage.telegram_message_id > msg.message_id).limit(1))
            if newer:
                return {'ok': True, 'ignored': True, 'reason': 'Resposta antiga recebida após uma proposta mais recente.'}
            row = ChatMessage(request_id=outgoing.request_id, supplier_domain=outgoing.supplier_domain, chat_id=msg.chat.id, sender_type='SUPPLIER', text=msg.text, timestamp=timestamp(), telegram_message_id=msg.message_id)
            db.add(row)
            db.flush()
            receipt.request_id = row.request_id
            receipt.message_id = row.id
            receipt.processed = False
            return {'ok': True}
    except IntegrityError:
        with SessionLocal() as db:
            if db.get(TelegramUpdate, update.update_id):
                return {'ok': True, 'duplicate': True}
        raise


router = APIRouter()


@router.post('/webhook/telegram')
async def webhook(payload: IncomingUpdate, x_telegram_bot_api_secret_token: str | None = Header(default=None)):
    secret = settings.telegram_webhook_secret
    if not secret:
        raise HTTPException(503, 'Webhook Telegram não configurado.')
    if not x_telegram_bot_api_secret_token or not secrets.compare_digest(x_telegram_bot_api_secret_token.encode(), secret.get_secret_value().encode()):
        raise HTTPException(401, 'Credencial do webhook inválida.')
    result = await run_in_threadpool(receive, payload)
    if result.get('ignored') and result.get('reason', '').startswith('Responda diretamente') and payload.message:
        try:
            if payload.message.chat.id == personal_telegram_chat_id():
                await telegram('sendMessage', {'chat_id': payload.message.chat.id, 'text': 'Não consegui associar sua resposta a uma cotação. Use Responder na mensagem de cotação do Roberto e reenvie os termos; isso evita registrar o preço em outro pedido.'})
        except (MessagingError, ValueError):
            logging.getLogger(__name__).warning('Não foi possível entregar a orientação de associação da resposta.')
    return result


def chat_history(request_id: int, after: int):
    with SessionLocal() as db:
        if not db.get(MarketRun, request_id):
            raise HTTPException(404, 'Solicitação não encontrada.')
        query = select(ChatMessage).where(ChatMessage.request_id == request_id, ChatMessage.id > after)
        rows = list(db.scalars(query.order_by(ChatMessage.id if after else ChatMessage.id.desc()).limit(200)))
        if not after:
            rows.reverse()
        return [{'id': r.id, 'request_id': r.request_id, 'supplier_domain': r.supplier_domain, 'sender_type': r.sender_type.upper(), 'text': r.text, 'timestamp': r.timestamp, 'delivery_status': r.delivery_status} for r in rows]


@router.get('/chat/{request_id}')
async def chat(request_id: int, after: int = 0):
    if after < 0:
        raise HTTPException(422, 'Cursor inválido.')
    return await run_in_threadpool(chat_history, request_id, after)


class InviteInput(BaseModel):
    model_config = ConfigDict(extra='forbid', str_strip_whitespace=True)
    name: str = Field(min_length=2, max_length=300)
    domain: str = Field(min_length=3, max_length=255, pattern=r'^[a-zA-Z0-9.-]+$')


def create_invite(payload: InviteInput):
    canonical = domain('https://' + payload.domain)
    if not canonical or canonical != payload.domain.lower():
        raise HTTPException(422, 'Use o domínio principal da loja, sem www ou caminho.')
    token = secrets.token_urlsafe(32)
    with SessionLocal.begin() as db:
        row = db.get(SupplierMemory, canonical)
        if row and row.authorized_at:
            raise HTTPException(409, 'Fornecedor já possui contato autorizado.')
        if not row:
            row = SupplierMemory(domain=canonical, name=payload.name)
            db.add(row)
        row.name = payload.name
        row.invite_hash = hashlib.sha256(token.encode()).hexdigest()
        row.invite_expires = (datetime.now(timezone.utc) + timedelta(hours=24)).isoformat()
    return token


@router.post('/suppliers/invite')
async def invite(payload: InviteInput, request: Request, x_nexo_settings: str | None = Header(default=None)):
    if request.headers.get('origin') not in {v.strip() for v in settings.cors_origins.split(',')} or x_nexo_settings != '1':
        raise HTTPException(403, 'Cadastre contatos pela aplicação local.')
    try:
        bot = await telegram('getMe', {})
        token = await run_in_threadpool(create_invite, payload)
        return {'url': f"https://t.me/{bot['username']}?start={token}", 'expires_in_hours': 24}
    except MessagingError as exc:
        raise HTTPException(503, str(exc)) from None


@router.get('/suppliers/contacts')
async def contacts():
    def read():
        with SessionLocal() as db:
            return [{'name': r.name, 'domain': r.domain, 'authorized': bool(r.authorized_at)} for r in db.scalars(select(SupplierMemory).order_by(SupplierMemory.name))]
    return await run_in_threadpool(read)
