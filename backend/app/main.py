import asyncio
import logging
import fcntl
from contextlib import asynccontextmanager, suppress

from fastapi import FastAPI, APIRouter, HTTPException, Request, Header
from fastapi.middleware.cors import CORSMiddleware
from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver
from pydantic import BaseModel, HttpUrl
from sqlalchemy import select, update
from starlette.concurrency import run_in_threadpool

from .config import settings, personal_telegram_chat_id
from .database import SessionLocal, engine, AgentJob, ChatMessage, AgentTrace
from .models import Base, PurchaseRequest, RequestStatus
from .orchestrator import router as dashboard_router
from .search_provider import router as search_router
from .messaging import router as messaging_router, telegram, MessagingError
from .agent import router as agent_router, build_graph, worker
from .local_access import LocalAccess
from .routers.voice_webhook import router as voice_router


logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(name)s %(message)s')
logging.getLogger('httpx').setLevel(logging.WARNING)
logging.getLogger('httpcore').setLevel(logging.WARNING)
logging.getLogger('httpx2').setLevel(logging.WARNING)
logging.getLogger('httpcore2').setLevel(logging.WARNING)


def initialize_database():
    Base.metadata.create_all(engine)
    with SessionLocal.begin() as db:
        db.execute(update(PurchaseRequest).where(PurchaseRequest.status.in_([RequestStatus.CALLING, RequestStatus.NEGOTIATING])).values(status=RequestStatus.TODO, last_error='Execução antiga interrompida.'))
        db.execute(update(ChatMessage).where(ChatMessage.sender_type == 'ai').values(sender_type='AI'))
        db.execute(update(ChatMessage).where(ChatMessage.sender_type == 'supplier').values(sender_type='SUPPLIER'))
        for trace in db.scalars(select(AgentTrace).where(AgentTrace.status == 'running')):
            trace.status = 'interrupted'
        for job in db.scalars(select(AgentJob).where(AgentJob.status == 'running')):
            job.status = 'pending'
        for message in db.scalars(select(ChatMessage).where(ChatMessage.delivery_status == 'sending')):
            message.delivery_status = 'unconfirmed'


@asynccontextmanager
async def lifespan(application: FastAPI):
    settings.agent_checkpoint_path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    lock = open(str(settings.agent_checkpoint_path) + '.worker.lock', 'a')
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        lock.close()
        raise RuntimeError('Já existe um worker usando estes checkpoints. Execute apenas um processo.') from None
    try:
        await run_in_threadpool(initialize_database)
        async with AsyncSqliteSaver.from_conn_string(str(settings.agent_checkpoint_path)) as saver:
            await saver.setup()
            graph = build_graph(saver)
            application.state.graph = graph
            task = asyncio.create_task(worker(graph))
            application.state.agent_task = task
            try:
                yield
            finally:
                task.cancel()
                with suppress(asyncio.CancelledError):
                    await task
        await run_in_threadpool(engine.dispose)
    finally:
        lock.close()



app = FastAPI(title='Nexo · Autonomous Procurement', version='3.0.0', lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=[v.strip() for v in settings.cors_origins.split(',')], allow_credentials=False, allow_methods=['GET', 'POST', 'OPTIONS'], allow_headers=['Content-Type', 'Idempotency-Key', 'Last-Event-ID', 'X-Nexo-Settings'])
app.add_middleware(LocalAccess)
read_router = APIRouter()
read_router.routes = [route for route in dashboard_router.routes if 'GET' in route.methods and route.path != '/health']
app.include_router(read_router)
app.include_router(agent_router)
app.include_router(messaging_router)
app.include_router(search_router)
app.include_router(voice_router)


@app.get('/health')
async def health():
    task = getattr(app.state, 'agent_task', None)
    return {'status': 'ok' if task and not task.done() else 'degraded', 'market_mode': 'real', 'messaging_mode': 'telegram', 'currency': 'BRL', 'engine_version': 2, 'agents': ['discovery_node', 'memory_profiler_node', 'tactical_negotiator_node', 'compliance_auditor_node']}


@app.get('/integrations/agent')
async def integrations():
    info = {'groq_configured': bool(settings.groq_api_key), 'requested_model': settings.groq_model, 'telegram_configured': bool(settings.telegram_bot_token), 'webhook_secret_configured': bool(settings.telegram_webhook_secret), 'webhook_url': None, 'webhook_error': None}
    try:
        personal_telegram_chat_id()
        info.update(sandbox_configured=True, sandbox_error=None)
    except ValueError as exc:
        info.update(sandbox_configured=False, sandbox_error=str(exc))
    if settings.telegram_bot_token:
        try:
            result = await telegram('getWebhookInfo', {})
            info['webhook_url'] = result.get('url') or None
            info['webhook_error'] = result.get('last_error_message')
        except MessagingError as exc:
            info['webhook_error'] = str(exc)
    return info


class WebhookConfiguration(BaseModel):
    url: HttpUrl


@app.post('/integrations/telegram/webhook')
async def configure_webhook(payload: WebhookConfiguration, request: Request, x_nexo_settings: str | None = Header(default=None)):
    if request.headers.get('origin') not in {v.strip() for v in settings.cors_origins.split(',')} or x_nexo_settings != '1':
        raise HTTPException(403, 'Configure o webhook pela aplicação local.')
    if payload.url.scheme != 'https' or payload.url.path.rstrip('/') != '/webhook/telegram' or payload.url.username or payload.url.password or not settings.telegram_webhook_secret:
        raise HTTPException(422, 'Informe uma URL HTTPS pública e configure TELEGRAM_WEBHOOK_SECRET no backend.')
    try:
        await telegram('setWebhook', {'url': str(payload.url), 'secret_token': settings.telegram_webhook_secret.get_secret_value(), 'allowed_updates': ['message'], 'drop_pending_updates': False})
        return {'configured': True}
    except MessagingError as exc:
        raise HTTPException(503, str(exc)) from None
