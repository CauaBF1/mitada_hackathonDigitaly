import asyncio
import logging
import secrets
from datetime import datetime, timezone
from decimal import Decimal, ROUND_HALF_UP
from typing import Annotated, Literal

from fastapi import APIRouter, BackgroundTasks, Header, HTTPException, Query, Request
from fastapi.responses import StreamingResponse
from langgraph.graph import END, START, StateGraph
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import String, Text, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Mapped, mapped_column
from starlette.concurrency import run_in_threadpool
from typing_extensions import TypedDict

from .commercial import AdditionalCost
from .config import settings
from .agent_intelligence import DiscoveryPlan, MemoryProfile, TacticalSummary
from .database import SessionLocal, AgentJob
from .models import Base
from .schemas import PositiveMoney, NonnegativeMoney
from .scraper_tools import Discovery, MarketScraper, ProductOffer, Reputation, ScrapingError, SearchCandidate, equivalent_product, timestamp

logger = logging.getLogger(__name__)


def money(value: Decimal) -> Decimal:
    return value.quantize(Decimal('0.01'), rounding=ROUND_HALF_UP)


class MarketRun(Base):
    __tablename__ = 'real_market_runs'
    id: Mapped[int] = mapped_column(primary_key=True)
    client_key: Mapped[str | None] = mapped_column(String(64), unique=True)
    phase: Mapped[str] = mapped_column(String(32), default='queued', index=True)
    original_input: Mapped[str] = mapped_column(Text)
    snapshot: Mapped[str] = mapped_column(Text)


class MarketEvent(Base):
    __tablename__ = 'real_market_events'
    id: Mapped[int] = mapped_column(primary_key=True)
    run_id: Mapped[int] = mapped_column(index=True)
    created_at: Mapped[str] = mapped_column(String(40))
    stage: Mapped[str] = mapped_column(String(64))
    level: Mapped[str] = mapped_column(String(16))
    message: Mapped[str] = mapped_column(Text)


class Contract(BaseModel):
    model_config = ConfigDict(extra='forbid', from_attributes=True, str_strip_whitespace=True)


class PurchaseInput(Contract):
    mode: Literal['live', 'sandbox'] = 'live'
    item: str = Field(min_length=3, max_length=300)
    qty: int = Field(gt=0, le=1000000, strict=True)
    target_price: PositiveMoney | None = None
    delivery_location: str | None = Field(default=None, min_length=2, max_length=200)
    profile: str = Field(default='saude', max_length=50)


class SupplierQuote(Contract):
    additional_costs: list[AdditionalCost] | None = None
    initial_additional_costs: list[AdditionalCost] | None = None
    initial_offer_evidence: list[dict] = Field(default_factory=list)
    initial_message_id: int | None = None
    supplier_domain: str | None = None
    supplier_name: str | None = None
    product_name: str | None = None
    quantity: int | None = None
    delivery_location: str | None = None
    source_type: Literal['legacy_unverified', 'supplier_telegram', 'sandbox_supplier'] = 'legacy_unverified'
    agreement_status: Literal['legacy_unverified', 'confirmed_quote'] = 'legacy_unverified'

    request_id: int = Field(gt=0, strict=True)
    event_id: str = Field(min_length=1, max_length=128)
    product_url: str = Field(min_length=10, max_length=2048)
    initial_price: PositiveMoney
    final_price: NonnegativeMoney
    available_qty: int = Field(ge=0, strict=True)
    delivery_time: str = Field(min_length=1, max_length=300)
    conditions: str = Field(min_length=1, max_length=4000)
    shipping_fee: NonnegativeMoney | None = None
    initial_shipping_fee: NonnegativeMoney | None = None
    delivery_days: int | None = Field(default=None, ge=0, le=3650)
    delivery_day_type: Literal['business', 'calendar', 'unspecified'] = 'unspecified'
    initial_tco: Decimal | None = None
    final_tco: Decimal | None = None


class ComplianceAudit(Contract):
    additional_costs: list[AdditionalCost] | None = None
    additional_cost_total: Decimal | None = None
    source_type: Literal['legacy_unverified', 'supplier_telegram', 'sandbox_supplier'] = 'legacy_unverified'
    agreement_status: Literal['legacy_unverified', 'confirmed_quote'] = 'legacy_unverified'
    savings_status: Literal['legacy_unverified', 'negotiated', 'sandbox'] = 'legacy_unverified'
    confidence: Literal['legacy_unverified', 'evidence_validated'] = 'legacy_unverified'
    missing_information: list[str] = Field(default_factory=list)

    roi_basis: Literal['tco_v1', 'unit_price'] = 'tco_v1'
    deal_closed: bool = True
    final_unit_price: Decimal | None = None
    final_shipping_fee: Decimal | None = None
    final_total_cost: Decimal | None = None
    audit_justification: str | None = None
    shipping_savings: Decimal | None = None
    tco_savings: Decimal | None = None
    tco_cost_avoidance: Decimal | None = None
    final_price: Decimal
    shipping_fee: Decimal
    delivery_days: int
    delivery_day_type: Literal['business', 'calendar', 'unspecified']
    quantity: int
    product_subtotal: Decimal
    initial_tco: Decimal | None
    final_tco: Decimal
    market_tco: Decimal | None
    hard_savings: Decimal | None
    cost_avoidance: Decimal | None
    justification: str
    limitations: list[str] = Field(default_factory=list)
    evidence_message_ids: list[int] = Field(default_factory=list)
    audited_at: str


class PurchaseRead(Contract):
    mode: Literal['live', 'sandbox'] = 'live'
    id: int
    item: str
    qty: int
    delivery_location: str | None = None
    profile: str = 'saude'
    tco_base: Decimal | None = None
    market_shipping: Decimal | None = None
    target_basis: Literal['complete_tco', 'product_subtotal', 'legacy_unit_price'] = 'legacy_unit_price'
    audit: ComplianceAudit | None = None
    discovery_justification: str | None = None
    discovery_plan: DiscoveryPlan | None = None
    supplier_profiles: dict[str, MemoryProfile] = Field(default_factory=dict)
    tactical_summary: TacticalSummary | None = None
    model_used: str | None = None
    requested_target: Decimal | None = None
    target_price: Decimal | None = None
    market_average: Decimal | None = None
    status: Literal['TODO', 'CALLING', 'NEGOTIATING', 'DONE'] = 'TODO'
    stage: str = 'queued'
    candidates: list[SearchCandidate] = Field(default_factory=list)
    comparison_item: str | None = None
    selected_candidate_url: str | None = None
    blocked_sites: int = 0
    sources: list[ProductOffer] = Field(default_factory=list)
    reputations: list[Reputation] = Field(default_factory=list)
    selected_product_url: str | None = None
    quote: SupplierQuote | None = None
    hard_savings: Decimal | None = None
    cost_avoidance: Decimal | None = None
    errors: list[str] = Field(default_factory=list)
    notice: str | None = None
    created_at: str
    updated_at: str
    data_mode: Literal['real'] = 'real'


class Metrics(Contract):
    hard_savings: Decimal = Decimal('0.00')
    cost_avoidance: Decimal = Decimal('0.00')
    final_spend: Decimal = Decimal('0.00')
    completed_count: int = 0
    active_count: int = 0
    verified_suppliers_count: int = 0
    pending_tco_count: int = 0


class Dashboard(Contract):
    runs: list[PurchaseRead]
    metrics: Metrics
    total_runs: int
    data_mode: Literal['real'] = 'real'


class EventRead(Contract):
    id: int
    run_id: int
    created_at: str
    stage: str
    level: str
    message: str


class ProcurementState(TypedDict, total=False):
    run_id: int
    item: str
    qty: int
    sources: list[dict]
    reputations: list[dict]
    enough: bool
    needs_selection: bool
    comparison_item: str | None
    selected_product_url: str | None


def event(session, run_id: int, stage: str, message: str, level='info'):
    session.add(MarketEvent(run_id=run_id, created_at=timestamp(), stage=stage, level=level, message=message))


def persist_update(run_id: int, stage: str, message: str, patch: dict | None = None, level='info'):
    with SessionLocal.begin() as session:
        run = session.get(MarketRun, run_id)
        data = PurchaseRead.model_validate_json(run.snapshot).model_dump(mode='json')
        data.update(patch or {})
        data.update(stage=stage, updated_at=timestamp())
        run.snapshot = PurchaseRead.model_validate(data).model_dump_json()
        run.phase = stage
        event(session, run_id, stage, message, level)


async def emit(state: ProcurementState, stage: str, message: str, patch: dict | None = None, level='info'):
    await run_in_threadpool(persist_update, state['run_id'], stage, message, patch, level)


def create_purchase(payload: PurchaseInput, key: str | None, enqueue: bool = False) -> PurchaseRead:
    encoded = payload.model_dump_json()
    try:
        with SessionLocal.begin() as session:
            if key:
                old = session.scalar(select(MarketRun).where(MarketRun.client_key == key))
                if old:
                    if PurchaseInput.model_validate_json(old.original_input) != payload:
                        raise HTTPException(409, 'Chave já utilizada com outra solicitação.')
                    if enqueue and not session.get(AgentJob, old.id):
                        session.add(AgentJob(request_id=old.id))
                    return PurchaseRead.model_validate_json(old.snapshot)
            run = MarketRun(client_key=key, phase='queued', original_input=encoded, snapshot='{}')
            session.add(run)
            session.flush()
            row = PurchaseRead(mode=payload.mode, id=run.id, item=payload.item, qty=payload.qty, delivery_location=payload.delivery_location, requested_target=payload.target_price, profile=payload.profile, created_at=timestamp(), updated_at=timestamp())
            run.snapshot = row.model_dump_json()
            if enqueue:
                session.add(AgentJob(request_id=run.id))
            event(session, run.id, 'queued', 'Solicitação recebida. Descoberta de fornecedores e preços reais agendada.')
            return row
    except IntegrityError as exc:
        raise HTTPException(409, 'Criação concorrente; repita com a mesma chave.') from exc


def claim(run_id: int) -> ProcurementState | None:
    with SessionLocal.begin() as session:
        result = session.execute(update(MarketRun).where(MarketRun.id == run_id, MarketRun.phase == 'queued').values(phase='discovery'))
        if result.rowcount != 1:
            return None
        run = session.get(MarketRun, run_id)
        row = PurchaseRead.model_validate_json(run.snapshot)
        row.status = 'CALLING'
        row.stage = 'discovery'
        run.snapshot = row.model_dump_json()
        return {'run_id': run.id, 'item': row.comparison_item or row.item, 'qty': row.qty, 'comparison_item': row.comparison_item}


async def market_intelligence_pricing(state: ProcurementState) -> dict:
    await emit(state, 'discovery', f"Pesquisando na web: {state['item']}. Preços serão extraídos das páginas dos produtos.")
    async with MarketScraper() as scraper:
        async def progress(partial):
            await emit(state, 'discovery', f'{len(partial.candidates)} links encontrados; verificando páginas.', {'candidates': [c.model_dump(mode='json') for c in partial.candidates]})
        scraper.on_progress = progress
        result = await asyncio.wait_for(scraper.discover(state['item']), settings.discovery_timeout_seconds + 5)
    if state.get('comparison_item'):
        result.products = [p for p in result.products if equivalent_product(state['comparison_item'], p.product_name)]
    candidates = {c.url: c for c in result.candidates}
    for product in result.products:
        candidates[product.product_url] = SearchCandidate(url=product.product_url, title=product.product_name, product_name=product.product_name, kind='product', price=product.price)
    sources = [product.model_dump(mode='json') for product in result.products]
    needs_selection = not state.get('comparison_item') and bool(candidates)
    patch = {'sources': sources, 'errors': result.errors, 'candidates': [c.model_dump(mode='json') for c in candidates.values()], 'blocked_sites': result.blocked_sites}
    enough = bool(state.get('comparison_item')) and len({product.supplier_domain for product in result.products}) >= 3
    if enough:
        average = money(sum(product.price for product in result.products) / len(result.products))
        patch.update(market_average=str(average), target_price=str(max(Decimal('0.01'), money(average * Decimal('0.85')))))
    await emit(state, 'discovery', f'{len(sources)} fornecedores distintos com produto correspondente e preço BRL publicado.', patch)
    return {'sources': sources, 'enough': enough, 'needs_selection': needs_selection}


async def compliance_check(state: ProcurementState) -> dict:
    await emit(state, 'compliance', 'Consultando páginas oficiais do ReclameAqui. Notas desconhecidas não serão aprovadas.')
    async with MarketScraper() as scraper:
        async def check(raw):
            product = ProductOffer.model_validate(raw)
            try:
                reputation = await asyncio.wait_for(scraper.reputation(product), 45)
            except (TimeoutError, ScrapingError) as exc:
                reputation = Reputation(supplier_domain=product.supplier_domain, checked_at=timestamp(), reason=str(exc) or 'Consulta de reputação excedeu o prazo.')
            await emit(state, 'compliance', f'{product.supplier_name}: {reputation.reason}', level='info' if reputation.approved else 'warning')
            return reputation
        rows = await asyncio.gather(*(check(raw) for raw in state['sources']))
    reputations = [row.model_dump(mode='json') for row in rows]
    await emit(state, 'compliance', 'Verificação de reputação concluída.', {'reputations': reputations})
    return {'reputations': reputations}


async def select_supplier(state: ProcurementState) -> dict:
    approved = {row['supplier_domain'] for row in state['reputations'] if row['verified'] and row['approved']}
    products = [ProductOffer.model_validate(raw) for raw in state['sources'] if raw['supplier_domain'] in approved]
    if not products:
        await emit(state, 'blocked', 'Nenhum fornecedor com reputação verificada e nota ≥ 6,0. Nenhuma chamada foi iniciada.', {'status': 'TODO', 'notice': 'Reputação indisponível ou reprovada. Consulte os links e tente novamente mais tarde.'}, 'warning')
        return {'selected_product_url': None}
    selected = min(products, key=lambda row: (row.price, row.supplier_domain))
    await emit(state, 'ready_for_voice', f'{selected.supplier_name} selecionado após comparação real e compliance. Aguardando cotação comercial; nenhuma chamada foi iniciada.', {
        'status': 'NEGOTIATING', 'selected_product_url': selected.product_url,
        'notice': 'Fornecedor selecionado. Telefonia e contato comercial precisam estar configurados para ligar. Economias só serão reconhecidas após receber uma cotação final autenticada.',
    })
    return {'selected_product_url': selected.product_url}


async def insufficient_market(state: ProcurementState) -> dict:
    await emit(state, 'blocked', 'Não foram encontrados pelo menos 3 fornecedores distintos com preços verificáveis. A seleção e as chamadas foram interrompidas.', {
        'status': 'TODO', 'notice': 'Pesquisa incompleta. Informe marca e modelo específicos ou tente novamente. Não há valores de demonstração.',
    }, 'warning')
    return {}


async def await_selection(state: ProcurementState) -> dict:
    await emit(state, 'awaiting_selection', 'Resultados disponíveis. Escolha um produto antes de comparar fornecedores.', {'status': 'TODO', 'notice': 'Escolha um produto identificado ou explore os links. Preços não confirmados não entram na média.'})
    return {}


def build_graph():
    builder = StateGraph(ProcurementState)
    for node in (market_intelligence_pricing, compliance_check, select_supplier, insufficient_market, await_selection):
        builder.add_node(node.__name__, node)
    builder.add_edge(START, 'market_intelligence_pricing')
    builder.add_conditional_edges('market_intelligence_pricing', lambda state: 'await_selection' if state.get('needs_selection') else 'compliance_check' if state['enough'] else 'insufficient_market', {'await_selection': 'await_selection', 'compliance_check': 'compliance_check', 'insufficient_market': 'insufficient_market'})
    builder.add_edge('compliance_check', 'select_supplier')
    builder.add_edge('select_supplier', END)
    builder.add_edge('insufficient_market', END)
    builder.add_edge('await_selection', END)
    return builder.compile()


graph = build_graph()


async def process_purchase_request(run_id: int) -> None:
    try:
        state = await run_in_threadpool(claim, run_id)
        if state is not None:
            await graph.ainvoke(state, config={'recursion_limit': 10})
    except asyncio.CancelledError:
        await run_in_threadpool(persist_update, run_id, 'failed', 'Consulta interrompida.', {'status': 'TODO', 'notice': 'Consulta interrompida. Tente novamente.'}, 'error')
        raise
    except Exception as exc:
        logger.exception('Real discovery failed for %s', run_id)
        message = str(exc) if isinstance(exc, ScrapingError) else 'A consulta real não pôde ser concluída dentro do prazo. Tente novamente.'
        await run_in_threadpool(persist_update, run_id, 'failed', message, {'status': 'TODO', 'notice': message}, 'error')


def recover_runs():
    with SessionLocal() as session:
        ids = list(session.scalars(select(MarketRun.id).where(MarketRun.phase.in_(['queued', 'discovery', 'compliance', 'exploring']))))
    for run_id in ids:
        persist_update(run_id, 'failed', 'Execução interrompida pela reinicialização do servidor.', {'status': 'TODO', 'notice': 'Servidor reiniciado. Use Tentar novamente.'}, 'error')


def retry_purchase(run_id: int) -> PurchaseRead:
    with SessionLocal.begin() as session:
        run = session.get(MarketRun, run_id)
        if run is None:
            raise HTTPException(404, 'Solicitação não encontrada.')
        if run.phase not in {'failed', 'blocked'}:
            raise HTTPException(409, 'Esta solicitação já está em execução ou aguardando cotação.')
        run.phase = 'queued'
        original = PurchaseInput.model_validate_json(run.original_input)
        old = PurchaseRead.model_validate_json(run.snapshot)
        row = PurchaseRead(mode=old.mode, id=run.id, item=original.item, qty=original.qty, requested_target=original.target_price, created_at=old.created_at, updated_at=timestamp(), comparison_item=old.comparison_item, selected_candidate_url=old.selected_candidate_url, candidates=old.candidates)
        run.snapshot = row.model_dump_json()
        event(session, run.id, 'queued', 'Nova tentativa de pesquisa real solicitada.')
        return row


def normalize_roi(row: PurchaseRead) -> PurchaseRead:
    audit, quote = row.audit, row.quote
    if audit and quote and audit.roi_basis == 'tco_v1':
        audit.tco_savings = audit.hard_savings
        audit.tco_cost_avoidance = audit.cost_avoidance
        audit.hard_savings = money((quote.initial_price - quote.final_price) * row.qty)
        audit.cost_avoidance = money((row.market_average - quote.final_price) * row.qty) if row.market_average is not None else None
        audit.shipping_savings = money(quote.initial_shipping_fee - audit.shipping_fee) if quote.initial_shipping_fee is not None else None
        audit.final_unit_price, audit.final_shipping_fee, audit.final_total_cost = audit.final_price, audit.shipping_fee, audit.final_tco
        audit.audit_justification = audit.justification
        audit.roi_basis = 'unit_price'
        row.hard_savings, row.cost_avoidance = audit.hard_savings, audit.cost_avoidance
    return row


def read_dashboard() -> Dashboard:
    metrics = Metrics()
    suppliers = set()
    with SessionLocal() as session:
        rows = [normalize_roi(PurchaseRead.model_validate_json(run.snapshot)) for run in session.scalars(select(MarketRun).order_by(MarketRun.id.desc()))]
    for row in rows:
        if row.mode == 'sandbox':
            continue
        metrics.active_count += int(row.stage in {'queued', 'discovery', 'compliance', 'memory_profiler', 'auditing', 'exploring', 'dispatch', 'negotiating'})
        suppliers.update(source.supplier_domain for source in row.sources)
        if row.status == 'DONE' and row.quote:
            if not row.audit or row.audit.agreement_status != 'confirmed_quote' or row.audit.source_type != 'supplier_telegram':
                metrics.pending_tco_count += 1
                continue
            metrics.completed_count += 1
            if row.quote.final_tco is None:
                metrics.pending_tco_count += 1
                continue
            metrics.hard_savings += row.hard_savings or Decimal('0.00')
            metrics.cost_avoidance += row.cost_avoidance or Decimal('0.00')
            metrics.final_spend += row.quote.final_tco
            metrics.pending_tco_count += int(not row.audit or row.audit.initial_tco is None or row.audit.market_tco is None)
    metrics.verified_suppliers_count = len(suppliers)
    return Dashboard(runs=rows[:100], metrics=metrics, total_runs=len(rows))


def finalize_supplier_quote(payload: SupplierQuote) -> PurchaseRead:
    with SessionLocal.begin() as session:
        run = session.get(MarketRun, payload.request_id)
        if run is None:
            raise HTTPException(404, 'Solicitação real não encontrada.')
        row = PurchaseRead.model_validate_json(run.snapshot)
        if row.quote:
            if row.quote == payload:
                return row
            raise HTTPException(409, 'Já existe uma cotação final diferente.')
        if run.phase != 'ready_for_voice' or payload.product_url != row.selected_product_url:
            raise HTTPException(409, 'Cotação não corresponde ao fornecedor selecionado e aprovado.')
        if payload.available_qty < row.qty:
            raise HTTPException(422, 'Estoque insuficiente para a quantidade solicitada.')
        payload.initial_price = money(payload.initial_price)
        payload.final_price = money(payload.final_price)
        row.quote = payload
        row.hard_savings = money((payload.initial_price - payload.final_price) * row.qty)
        row.cost_avoidance = money((row.market_average - payload.final_price) * row.qty)
        row.status = 'DONE'
        row.stage = 'completed'
        row.notice = 'Cotação final recebida. Nenhum pedido ou pagamento foi efetuado pela plataforma.'
        row.updated_at = timestamp()
        run.phase = 'completed'
        run.snapshot = row.model_dump_json()
        event(session, run.id, 'completed', 'Cotação comercial autenticada registrada; economias calculadas com a quantidade solicitada.', 'success')
        return row


def read_events(after: int, run_id: int | None = None) -> list[EventRead]:
    query = select(MarketEvent).where(MarketEvent.id > after)
    if run_id:
        query = query.where(MarketEvent.run_id == run_id)
    with SessionLocal() as session:
        return [EventRead.model_validate(row) for row in session.scalars(query.order_by(MarketEvent.id).limit(200))]


router = APIRouter()


@router.get('/health')
async def health():
    return {'status': 'ok', 'market_mode': 'real', 'voice_mode': 'not_configured', 'currency': 'BRL'}


@router.post('/request', response_model=PurchaseRead, status_code=201)
async def create_request(payload: PurchaseInput, background_tasks: BackgroundTasks, idempotency_key: Annotated[str | None, Header(min_length=1, max_length=64)] = None):
    row = await run_in_threadpool(create_purchase, payload, idempotency_key)
    if row.stage == 'queued':
        background_tasks.add_task(process_purchase_request, row.id)
    return row


@router.post('/request/{request_id}/retry', response_model=PurchaseRead, status_code=202)
async def retry(request_id: int, background_tasks: BackgroundTasks):
    row = await run_in_threadpool(retry_purchase, request_id)
    background_tasks.add_task(process_purchase_request, row.id)
    return row


class CandidateAction(Contract):
    url: str = Field(min_length=10, max_length=2048)


def candidate_action(run_id: int, url: str, explore: bool) -> tuple[PurchaseRead, SearchCandidate]:
    with SessionLocal.begin() as session:
        run = session.get(MarketRun, run_id)
        if not run:
            raise HTTPException(404, 'Solicitação não encontrada.')
        old_snapshot = run.snapshot
        row = PurchaseRead.model_validate_json(old_snapshot)
        if run.phase not in {'awaiting_selection', 'blocked', 'failed'}:
            raise HTTPException(409, 'Aguarde a conclusão da pesquisa antes de escolher.')
        candidate = next((c for c in row.candidates if c.url == url), None)
        if not candidate:
            raise HTTPException(422, 'Escolha um resultado registrado nesta solicitação.')
        if not explore and (candidate.kind != 'product' or not candidate.product_name):
            raise HTTPException(422, 'Explore a página para identificar o produto antes de selecionar.')
        row.stage = 'exploring' if explore else 'queued'
        row.status = 'TODO'
        if not explore:
            row.comparison_item = candidate.product_name
            row.selected_candidate_url = candidate.url
            row.sources = []
            row.reputations = []
            row.market_average = row.target_price = None
            row.selected_product_url = None
            row.errors = []
            row.notice = 'Comparando o modelo e a variante selecionados.'
        row.updated_at = timestamp()
        result = session.execute(update(MarketRun).where(MarketRun.id == run_id, MarketRun.snapshot == old_snapshot).values(phase=row.stage, snapshot=row.model_dump_json()))
        if result.rowcount != 1:
            raise HTTPException(409, 'Solicitação alterada. Atualize a página.')
        event(session, run_id, row.stage, 'Explorando página selecionada.' if explore else f'Produto escolhido: {candidate.product_name}.')
        return row, candidate


async def explore_candidate(row: PurchaseRead, candidate: SearchCandidate):
    try:
        async with MarketScraper() as scraper:
            found = await asyncio.wait_for(scraper.explore(candidate, row.item), 35)
        candidates = {c.url: c for c in row.candidates}
        candidates.update({c.url: c for c in found})
        persist = {'candidates': list(c.model_dump(mode='json') for c in candidates.values()), 'status': 'TODO', 'notice': 'Escolha um produto identificado ou explore outro resultado.'}
        await run_in_threadpool(persist_update, row.id, 'awaiting_selection', 'Exploração concluída; resultados preservados.', persist)
    except (ScrapingError, TimeoutError) as exc:
        message = str(exc) or 'Exploração excedeu o prazo.'
        await run_in_threadpool(persist_update, row.id, 'awaiting_selection', message, {'status': 'TODO', 'errors': row.errors + [message], 'notice': 'Não foi possível ler esta página. Os demais resultados continuam disponíveis.'}, 'warning')
    except Exception:
        logger.exception('Candidate exploration failed for %s', row.id)
        await run_in_threadpool(persist_update, row.id, 'awaiting_selection', 'Falha ao explorar página.', {'status': 'TODO', 'notice': 'Tente outro resultado.'}, 'error')


@router.post('/request/{request_id}/select', response_model=PurchaseRead, status_code=202)
async def choose_candidate(request_id: int, payload: CandidateAction, background_tasks: BackgroundTasks):
    row, candidate = await run_in_threadpool(candidate_action, request_id, payload.url, False)
    background_tasks.add_task(process_purchase_request, row.id)
    return row


@router.post('/request/{request_id}/explore', response_model=PurchaseRead, status_code=202)
async def explore_result(request_id: int, payload: CandidateAction, background_tasks: BackgroundTasks):
    row, candidate = await run_in_threadpool(candidate_action, request_id, payload.url, True)
    background_tasks.add_task(explore_candidate, row, candidate)
    return row


@router.get('/godmode/dashboard', response_model=Dashboard)
async def dashboard():
    return await run_in_threadpool(read_dashboard)


@router.get('/dashboard/metrics', response_model=Metrics)
async def dashboard_metrics():
    return (await run_in_threadpool(read_dashboard)).metrics


@router.get('/kanban', response_model=dict[str, list[PurchaseRead]])
async def kanban():
    rows = (await run_in_threadpool(read_dashboard)).runs
    return {status: [row for row in rows if row.status == status] for status in ('TODO', 'CALLING', 'NEGOTIATING', 'DONE')}


@router.post('/webhook/voice', response_model=PurchaseRead)
async def voice_webhook(payload: SupplierQuote, x_webhook_secret: Annotated[str | None, Header()] = None):
    if not settings.voice_webhook_secret:
        raise HTTPException(503, 'Recebimento de cotações desabilitado até configurar a autenticação do webhook.')
    if not x_webhook_secret or not secrets.compare_digest(x_webhook_secret.encode(), settings.voice_webhook_secret.encode()):
        raise HTTPException(401, 'Credencial de webhook inválida.')
    return await run_in_threadpool(finalize_supplier_quote, payload)


@router.get('/godmode/events/history', response_model=list[EventRead])
async def history(after: int = Query(default=0, ge=0, le=9223372036854775807), run_id: int | None = Query(default=None, gt=0)):
    return await run_in_threadpool(read_events, after, run_id)


@router.get('/godmode/events')
async def events(request: Request, after: int = Query(default=0, ge=0, le=9223372036854775807), run_id: int | None = Query(default=None, gt=0), last_event_id: Annotated[str | None, Header()] = None):
    if last_event_id:
        try:
            value = int(last_event_id)
            if value < 0 or value > 9223372036854775807:
                raise ValueError()
            after = max(after, value)
        except ValueError as exc:
            raise HTTPException(422, 'Cursor inválido.') from exc
    async def stream():
        cursor = after
        heartbeat = 0
        yield 'retry: 3000\n\n'
        while not await request.is_disconnected():
            for row in await run_in_threadpool(read_events, cursor, run_id):
                cursor = row.id
                yield f'id: {row.id}\nevent: log\ndata: {row.model_dump_json()}\n\n'
            heartbeat += 1
            if heartbeat == 20:
                yield ': heartbeat\n\n'
                heartbeat = 0
            await asyncio.sleep(0.5)
    return StreamingResponse(stream(), media_type='text/event-stream', headers={'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no'})
