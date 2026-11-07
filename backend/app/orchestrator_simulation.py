import asyncio
import logging
from datetime import datetime, timezone
from decimal import Decimal, ROUND_HALF_UP
from typing import Annotated, Any, Literal

from fastapi import APIRouter, BackgroundTasks, Header, HTTPException, Query, Request
from fastapi.responses import StreamingResponse
from langgraph.graph import END, START, StateGraph
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import ForeignKey, Integer, Numeric, String, Text, func, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Mapped, mapped_column
from starlette.concurrency import run_in_threadpool
from typing_extensions import TypedDict

from .config import settings
from .database import SessionLocal
from .models import Base, PurchaseRequest, Quote, RequestStatus, Supplier
from .schemas import NonnegativeMoney, PositiveMoney


logger = logging.getLogger(__name__)
CENT = Decimal("0.01")
MAX_MONEY = Decimal("9999999999.99")


def money(value: Any) -> Decimal:
    result = Decimal(str(value))
    if not result.is_finite():
        raise ValueError("Valor monetário inválido.")
    return result.quantize(CENT, rounding=ROUND_HALF_UP)


def unit_price(value: Any) -> Decimal:
    return min(MAX_MONEY, max(CENT, money(value)))


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


class AuctionRun(Base):
    __tablename__ = "auction_runs"

    id: Mapped[int] = mapped_column(primary_key=True)
    request_id: Mapped[int] = mapped_column(ForeignKey("purchase_requests.id"), unique=True)
    status: Mapped[str] = mapped_column(String(24), default="queued", index=True)
    reference_price: Mapped[Decimal] = mapped_column(Numeric(12, 2))
    snapshot: Mapped[str] = mapped_column(Text)


class AuctionEvent(Base):
    __tablename__ = "auction_events"

    id: Mapped[int] = mapped_column(primary_key=True)
    run_id: Mapped[int] = mapped_column(ForeignKey("auction_runs.id"), index=True)
    request_id: Mapped[int] = mapped_column(Integer)
    created_at: Mapped[str] = mapped_column(String(40))
    stage: Mapped[str] = mapped_column(String(64))
    level: Mapped[str] = mapped_column(String(16))
    message: Mapped[str] = mapped_column(Text)


class Contract(BaseModel):
    model_config = ConfigDict(extra="forbid", from_attributes=True, str_strip_whitespace=True)


class AuctionCreate(Contract):
    item: str = Field(min_length=1, max_length=300)
    reference_price: PositiveMoney
    qty: int = Field(gt=0, le=1_000_000, strict=True)


class MarketSource(Contract):
    name: str
    url: str
    unit_price: PositiveMoney
    observed_at: str
    simulated: Literal[True] = True


class SupplierAssessment(Contract):
    supplier_id: int
    name: str
    score: Decimal = Field(ge=0, le=10)
    approved: bool
    reason: str
    simulated: Literal[True] = True


class Bid(Contract):
    supplier_id: int
    name: str
    initial_price: PositiveMoney
    final_price: NonnegativeMoney
    available_qty: int = Field(ge=0, le=2147483647, strict=True)
    delivery_time: str = Field(min_length=1, max_length=300)
    conditions: str = Field(min_length=1, max_length=4000)
    rounds: int = Field(default=0, ge=0, le=3, strict=True)
    memory_used: bool = False
    simulated: Literal[True] = True


class AuctionRead(Contract):
    id: int
    request_id: int
    item: str
    qty: int
    reference_price: Decimal
    target_price: Decimal | None = None
    market_average: Decimal | None = None
    status: Literal["queued", "running", "completed", "failed"]
    stage: str
    created_at: str
    updated_at: str
    sources: list[MarketSource] = Field(default_factory=list)
    assessments: list[SupplierAssessment] = Field(default_factory=list)
    bids: list[Bid] = Field(default_factory=list)
    winner_id: int | None = None
    hard_savings: Decimal | None = None
    cost_avoidance: Decimal | None = None
    error: str | None = None
    simulated: Literal[True] = True


class AdvancedMetrics(Contract):
    hard_savings: Decimal = Decimal("0.00")
    cost_avoidance: Decimal = Decimal("0.00")
    market_baseline: Decimal = Decimal("0.00")
    initial_baseline: Decimal = Decimal("0.00")
    final_spend: Decimal = Decimal("0.00")
    discount_percentage: Decimal = Decimal("0.00")
    completed_count: int = 0
    active_count: int = 0
    successful_negotiations_count: int = 0


class DashboardRead(Contract):
    runs: list[AuctionRead]
    metrics: AdvancedMetrics
    total_runs: int
    simulated: Literal[True] = True


class EventRead(Contract):
    id: int
    run_id: int
    request_id: int
    created_at: str
    stage: str
    level: str
    message: str


class AuctionState(TypedDict, total=False):
    run_id: int
    request_id: int
    item: str
    qty: int
    reference_price: str
    target_price: str
    market_average: str
    sources: list[dict]
    assessments: list[dict]
    bids: list[dict]
    winner_id: int


def add_event(session, run: AuctionRun, stage: str, message: str, level: str = "info") -> None:
    session.add(AuctionEvent(
        run_id=run.id, request_id=run.request_id, created_at=now(),
        stage=stage, level=level, message=message,
    ))


def record_update(run_id: int, stage: str, message: str, patch: dict | None = None, level: str = "info") -> None:
    with SessionLocal.begin() as session:
        run = session.get(AuctionRun, run_id)
        if run is None or run.status != "running":
            return
        snapshot = AuctionRead.model_validate_json(run.snapshot)
        data = snapshot.model_dump(mode="json")
        data.update(patch or {})
        data.update(stage=stage, updated_at=now())
        run.snapshot = AuctionRead.model_validate(data).model_dump_json()
        add_event(session, run, stage, message, level)


async def emit(state: AuctionState, stage: str, message: str, patch: dict | None = None, level: str = "info") -> None:
    await run_in_threadpool(record_update, state["run_id"], stage, message, patch, level)


def seed_auction_suppliers() -> None:
    with SessionLocal.begin() as session:
        for name, phone in (
            ("Norte Distribuidora · simulação", "+551155550201"),
            ("Vertex Tecnologia · simulação", "+551155550202"),
            ("Prisma Supply · simulação", "+551155550203"),
        ):
            if session.scalar(select(Supplier.id).where(Supplier.phone == phone)) is None:
                session.add(Supplier(name=name, phone=phone))


def create_auction(payload: AuctionCreate, key: str | None) -> AuctionRead:
    try:
        with SessionLocal.begin() as session:
            if key:
                purchase = session.scalar(select(PurchaseRequest).where(PurchaseRequest.client_request_id == key))
                if purchase:
                    run = session.scalar(select(AuctionRun).where(AuctionRun.request_id == purchase.id))
                    if run is None or (purchase.item, purchase.qty, run.reference_price) != (payload.item, payload.qty, payload.reference_price):
                        raise HTTPException(409, "Esta chave já foi usada para outra solicitação.")
                    return AuctionRead.model_validate_json(run.snapshot)
            supplier = session.scalar(select(Supplier).order_by(Supplier.id).limit(1))
            if supplier is None:
                raise HTTPException(422, "Cadastre fornecedores antes de iniciar uma cotação.")
            purchase = PurchaseRequest(
                item=payload.item, qty=payload.qty, target_price=payload.reference_price,
                supplier_id=supplier.id, client_request_id=key, status=RequestStatus.TODO,
            )
            session.add(purchase)
            session.flush()
            run = AuctionRun(request_id=purchase.id, reference_price=payload.reference_price, status="queued", snapshot="{}")
            session.add(run)
            session.flush()
            snapshot = AuctionRead(
                id=run.id, request_id=purchase.id, **payload.model_dump(),
                status="queued", stage="queued", created_at=now(), updated_at=now(),
            )
            run.snapshot = snapshot.model_dump_json()
            add_event(session, run, "queued", f"Solicitação #{purchase.id} recebida. Mercado, reputação e voz em modo simulado.")
            return snapshot
    except IntegrityError as exc:
        raise HTTPException(409, "Solicitação concorrente. Repita com a mesma chave.") from exc


def claim_auction(run_id: int) -> AuctionState | None:
    with SessionLocal.begin() as session:
        changed = session.execute(update(AuctionRun).where(AuctionRun.id == run_id, AuctionRun.status == "queued").values(status="running"))
        if changed.rowcount != 1:
            return None
        run = session.get(AuctionRun, run_id)
        purchase = session.get(PurchaseRequest, run.request_id)
        if purchase.quote or purchase.status != RequestStatus.TODO:
            raise ValueError("Solicitação indisponível para leilão.")
        purchase.status = RequestStatus.CALLING
        purchase.last_error = None
        snapshot = AuctionRead.model_validate_json(run.snapshot)
        snapshot.status = "running"
        snapshot.updated_at = now()
        run.snapshot = snapshot.model_dump_json()
        return {"run_id": run.id, "request_id": purchase.id, "item": purchase.item, "qty": purchase.qty, "reference_price": str(run.reference_price)}


async def mock_delay() -> None:
    await asyncio.sleep(min(settings.mock_voice_delay_seconds, 3))


async def market_intelligence_pricing(state: AuctionState) -> dict:
    await emit(state, "market_intelligence_pricing", "Consultando referências de mercado simuladas; nenhuma página externa é acessada.")
    await mock_delay()
    reference = Decimal(state["reference_price"])
    sources = [MarketSource(name=name, url=url, unit_price=unit_price(reference * factor), observed_at=now()) for name, url, factor in (
        ("Amazon", "https://www.amazon.com.br", Decimal("1.10")),
        ("KaBuM!", "https://www.kabum.com.br", Decimal("1.20")),
        ("Pichau", "https://www.pichau.com.br", Decimal("1.30")),
    )]
    average = money(sum(source.unit_price for source in sources) / len(sources))
    target = unit_price(average * Decimal("0.85"))
    patch = {"sources": [source.model_dump(mode="json") for source in sources], "market_average": str(average), "target_price": str(target)}
    def save_target():
        with SessionLocal.begin() as session:
            session.execute(update(PurchaseRequest).where(PurchaseRequest.id == state["request_id"], PurchaseRequest.status == RequestStatus.CALLING).values(target_price=target))
    await run_in_threadpool(save_target)
    await emit(state, "market_intelligence_pricing", f"Média unitária R$ {average:.2f}. Meta calculada: média × 0,85 = R$ {target:.2f}.", patch)
    return patch


def assess_suppliers() -> list[dict]:
    with SessionLocal() as session:
        suppliers = session.scalars(select(Supplier).order_by(Supplier.id).limit(50)).all()
        scores = (Decimal("8.8"), Decimal("7.9"), Decimal("6.8"), Decimal("4.9"))
        return [SupplierAssessment(
            supplier_id=supplier.id, name=supplier.name, score=scores[index % len(scores)],
            approved=scores[index % len(scores)] >= 6,
            reason="Nota simulada ≥ 6,0" if scores[index % len(scores)] >= 6 else "Rejeitado: nota simulada < 6,0",
        ).model_dump(mode="json") for index, supplier in enumerate(suppliers)]


async def compliance_check(state: AuctionState) -> dict:
    await emit(state, "compliance_check", "Verificando reputação no adaptador simulado de compliance. Limiar: 6,0/10.")
    assessments = await run_in_threadpool(assess_suppliers)
    await emit(state, "compliance_check", f"{sum(row['approved'] for row in assessments)} fornecedores aprovados; {sum(not row['approved'] for row in assessments)} rejeitados.", {"assessments": assessments})
    return {"assessments": assessments}


def supplier_history(supplier_id: int, item: str) -> Decimal | None:
    with SessionLocal() as session:
        return session.scalar(select(Quote.final_price).join(PurchaseRequest, Quote.request_id == PurchaseRequest.id).where(
            Quote.supplier_id == supplier_id, PurchaseRequest.item == item,
            PurchaseRequest.status == RequestStatus.DONE,
        ).order_by(Quote.id.desc()).limit(1))


async def mock_initial_call(state: AuctionState, supplier: dict, index: int) -> Bid:
    await emit(state, "parallel_voice_dispatch", f"Chamada simulada iniciada → {supplier['name']}.")
    previous = await run_in_threadpool(supplier_history, supplier["supplier_id"], state["item"])
    await mock_delay()
    initial = unit_price(Decimal(state["market_average"]) * (Decimal("0.98") + Decimal(index) * Decimal("0.04")))
    if previous is not None:
        initial = min(initial, unit_price(previous * Decimal("1.03")))
    bid = Bid(
        supplier_id=supplier["supplier_id"], name=supplier["name"], initial_price=initial, final_price=initial,
        available_qty=state["qty"], delivery_time=f"{index + 3} dias úteis", memory_used=previous is not None,
        conditions="Preço unitário em BRL; impostos e frete inclusos; pagamento em 30 dias. Oferta simulada.",
    )
    await emit(state, "parallel_voice_dispatch", f"{bid.name}: primeira oferta R$ {initial:.2f}/un.; estoque {bid.available_qty}." + (" Histórico utilizado." if bid.memory_used else ""))
    return bid


async def parallel_voice_dispatch(state: AuctionState) -> dict:
    approved = [supplier for supplier in state["assessments"] if supplier["approved"]][:3]
    await emit(state, "parallel_voice_dispatch", "Disparando 3 chamadas concorrentes no adaptador de voz simulado.")
    results = await asyncio.gather(*(mock_initial_call(state, supplier, index) for index, supplier in enumerate(approved)), return_exceptions=True)
    bids = []
    for result in results:
        if isinstance(result, BaseException):
            await emit(state, "parallel_voice_dispatch", "Uma chamada falhou. A oferta foi excluída do leilão.", level="warning")
        elif result.available_qty >= state["qty"]:
            bids.append(result.model_dump(mode="json"))
    if not bids:
        raise ValueError("Nenhum fornecedor retornou uma oferta válida com estoque suficiente.")
    await emit(state, "parallel_voice_dispatch", f"{len(bids)} ofertas válidas recebidas.", {"bids": bids})
    return {"bids": bids}


async def mock_counter_call(state: AuctionState, bid: Bid, lowest: Decimal) -> Bid:
    await emit(state, "reverse_auction_loop", f"Segunda chamada simulada → {bid.name}: pode melhorar R$ {lowest:.2f}/un., mantendo as condições?")
    await mock_delay()
    final = min(bid.final_price, unit_price(max(bid.initial_price * Decimal("0.78"), lowest * Decimal("0.98"))))
    result = bid.model_copy(update={"final_price": final, "rounds": 1})
    await emit(state, "reverse_auction_loop", f"{bid.name}: proposta final R$ {final:.2f}/un. Condições preservadas.")
    return result


async def reverse_auction_loop(state: AuctionState) -> dict:
    bids = [Bid.model_validate(bid) for bid in state["bids"]]
    leader = min(bids, key=lambda bid: (bid.final_price, bid.supplier_id))
    def negotiating():
        with SessionLocal.begin() as session:
            session.execute(update(PurchaseRequest).where(PurchaseRequest.id == state["request_id"], PurchaseRequest.status == RequestStatus.CALLING).values(status=RequestStatus.NEGOTIATING))
    await run_in_threadpool(negotiating)
    await emit(state, "reverse_auction_loop", f"Menor oferta: R$ {leader.final_price:.2f}. Iniciando uma rodada de leilão reverso.")
    competitors = [bid for bid in bids if bid.supplier_id != leader.supplier_id]
    results = await asyncio.gather(*(mock_counter_call(state, bid, leader.final_price) for bid in competitors), return_exceptions=True)
    final_bids = [leader]
    for original, result in zip(competitors, results):
        if isinstance(result, BaseException):
            final_bids.append(original)
            await emit(state, "reverse_auction_loop", f"{original.name}: segunda chamada falhou; primeira oferta preservada.", level="warning")
        else:
            final_bids.append(result)
    final_bids.sort(key=lambda bid: (bid.final_price, bid.supplier_id))
    patch = {"bids": [bid.model_dump(mode="json") for bid in final_bids], "winner_id": final_bids[0].supplier_id}
    await emit(state, "reverse_auction_loop", f"Melhor proposta: {final_bids[0].name}, R$ {final_bids[0].final_price:.2f}/un.", patch)
    return patch


def finalize_auction(state: AuctionState) -> None:
    winner = next(Bid.model_validate(bid) for bid in state["bids"] if bid["supplier_id"] == state["winner_id"])
    with SessionLocal.begin() as session:
        run = session.get(AuctionRun, state["run_id"])
        if run.status == "completed":
            return
        if run.status != "running":
            raise ValueError("Leilão indisponível para conclusão.")
        purchase = session.get(PurchaseRequest, state["request_id"])
        if purchase.quote is not None:
            raise ValueError("Solicitação já possui cotação.")
        if winner.available_qty < purchase.qty:
            raise ValueError("Quantidade disponível insuficiente.")
        purchase.supplier_id = winner.supplier_id
        purchase.status = RequestStatus.DONE
        purchase.last_error = None
        session.add(Quote(
            request_id=purchase.id, supplier_id=winner.supplier_id,
            initial_price=winner.initial_price, final_price=winner.final_price,
            available_qty=winner.available_qty, delivery_time=winner.delivery_time,
            conditions=winner.conditions, negotiation_rounds=winner.rounds,
        ))
        for raw in state["bids"]:
            bid = Bid.model_validate(raw)
            supplier = session.get(Supplier, bid.supplier_id)
            memory = f"Leilão simulado #{purchase.id}: {purchase.item}; qty={purchase.qty}; initial={bid.initial_price:.2f}; final={bid.final_price:.2f}; vencedor={bid.supplier_id == winner.supplier_id}; {bid.conditions}"
            supplier.memory_summary_vector_mock = (supplier.memory_summary_vector_mock + "\n" + memory).strip()[-16000:]
        snapshot = AuctionRead.model_validate_json(run.snapshot)
        snapshot.status = "completed"
        snapshot.stage = "completed"
        snapshot.updated_at = now()
        snapshot.hard_savings = money((winner.initial_price - winner.final_price) * purchase.qty)
        snapshot.cost_avoidance = money((Decimal(state["market_average"]) - winner.final_price) * purchase.qty)
        run.status = "completed"
        run.snapshot = snapshot.model_dump_json()
        target_result = "Meta alcançada." if winner.final_price <= Decimal(state["target_price"]) else "Melhor oferta acima da meta; meta não alcançada."
        add_event(session, run, "completed", f"Cotação simulada concluída. Hard Savings R$ {snapshot.hard_savings:.2f}; Cost Avoidance R$ {snapshot.cost_avoidance:.2f}. {target_result} Compra não efetuada.", "success")


async def stream_state_updates(state: AuctionState) -> dict:
    await run_in_threadpool(finalize_auction, state)
    return {}


async def reject_auction(state: AuctionState) -> dict:
    raise ValueError("São necessários 3 fornecedores aprovados com nota simulada ≥ 6,0 para iniciar as chamadas.")


def build_godmode_graph():
    builder = StateGraph(AuctionState)
    for node in (market_intelligence_pricing, compliance_check, parallel_voice_dispatch, reverse_auction_loop, stream_state_updates, reject_auction):
        builder.add_node(node.__name__, node)
    builder.add_edge(START, "market_intelligence_pricing")
    builder.add_edge("market_intelligence_pricing", "compliance_check")
    builder.add_conditional_edges("compliance_check", lambda state: "parallel_voice_dispatch" if sum(row["approved"] for row in state["assessments"]) >= 3 else "reject_auction", {"parallel_voice_dispatch": "parallel_voice_dispatch", "reject_auction": "reject_auction"})
    builder.add_edge("parallel_voice_dispatch", "reverse_auction_loop")
    builder.add_edge("reverse_auction_loop", "stream_state_updates")
    builder.add_edge("stream_state_updates", END)
    builder.add_edge("reject_auction", END)
    return builder.compile()


graph = build_godmode_graph()


def fail_auction(run_id: int, message: str) -> None:
    with SessionLocal.begin() as session:
        run = session.get(AuctionRun, run_id)
        if run is None or run.status not in {"queued", "running"}:
            return
        snapshot = AuctionRead.model_validate_json(run.snapshot)
        snapshot.status = "failed"
        snapshot.error = message
        snapshot.stage = "failed"
        snapshot.updated_at = now()
        run.status = "failed"
        run.snapshot = snapshot.model_dump_json()
        session.execute(update(PurchaseRequest).where(PurchaseRequest.id == run.request_id, PurchaseRequest.status != RequestStatus.DONE).values(status=RequestStatus.TODO, last_error=message))
        add_event(session, run, "failed", message, "error")


async def process_godmode_request(run_id: int) -> None:
    try:
        state = await run_in_threadpool(claim_auction, run_id)
        if state is not None:
            await graph.ainvoke(state, config={"recursion_limit": 12})
    except asyncio.CancelledError:
        await run_in_threadpool(fail_auction, run_id, "Execução interrompida. Crie uma nova cotação para retomar.")
        raise
    except Exception as exc:
        logger.exception("Godmode auction %s failed", run_id)
        await run_in_threadpool(fail_auction, run_id, str(exc) if isinstance(exc, ValueError) else "Falha na execução. Crie uma nova cotação para tentar novamente.")


def recover_auctions() -> None:
    with SessionLocal() as session:
        ids = list(session.scalars(select(AuctionRun.id).where(AuctionRun.status.in_(["queued", "running"]))))
    for run_id in ids:
        fail_auction(run_id, "Servidor reiniciado durante a execução. Crie uma nova cotação para retomar.")


def read_dashboard() -> DashboardRead:
    metrics = AdvancedMetrics()
    with SessionLocal() as session:
        total = session.scalar(select(func.count()).select_from(AuctionRun))
        latest = list(session.scalars(select(AuctionRun).order_by(AuctionRun.id.desc()).limit(50)))
        metrics.active_count = session.scalar(select(func.count()).select_from(AuctionRun).where(AuctionRun.status.in_(["queued", "running"])))
        for run in session.scalars(select(AuctionRun).where(AuctionRun.status == "completed")):
            row = AuctionRead.model_validate_json(run.snapshot)
            winner = next(bid for bid in row.bids if bid.supplier_id == row.winner_id)
            metrics.completed_count += 1
            metrics.hard_savings += row.hard_savings
            metrics.cost_avoidance += row.cost_avoidance
            metrics.market_baseline += row.market_average * row.qty
            metrics.initial_baseline += winner.initial_price * row.qty
            metrics.final_spend += winner.final_price * row.qty
            metrics.successful_negotiations_count += int(winner.final_price < winner.initial_price)
        if metrics.initial_baseline:
            metrics.discount_percentage = money(metrics.hard_savings / metrics.initial_baseline * 100)
        return DashboardRead(runs=[AuctionRead.model_validate_json(run.snapshot) for run in latest], metrics=metrics, total_runs=total)


def read_events(after: int, run_id: int | None = None, limit: int = 200) -> list[EventRead]:
    query = select(AuctionEvent).where(AuctionEvent.id > after)
    if run_id is not None:
        query = query.where(AuctionEvent.run_id == run_id)
    with SessionLocal() as session:
        return [EventRead.model_validate(event) for event in session.scalars(query.order_by(AuctionEvent.id).limit(limit))]


def encode_event(event: EventRead) -> str:
    return f"id: {event.id}\nevent: log\ndata: {event.model_dump_json()}\n\n"


router = APIRouter(prefix="/godmode", tags=["godmode"])


@router.post("/request", response_model=AuctionRead, status_code=201)
async def start_auction(payload: AuctionCreate, background_tasks: BackgroundTasks, idempotency_key: Annotated[str | None, Header(min_length=1, max_length=64)] = None):
    run = await run_in_threadpool(create_auction, payload, idempotency_key)
    if run.status == "queued":
        background_tasks.add_task(process_godmode_request, run.id)
    return run


@router.get("/dashboard", response_model=DashboardRead)
async def dashboard():
    return await run_in_threadpool(read_dashboard)


@router.get("/events/history", response_model=list[EventRead])
async def history(after: int = Query(default=0, ge=0, le=9223372036854775807), run_id: int | None = Query(default=None, gt=0, le=9223372036854775807)):
    return await run_in_threadpool(read_events, after, run_id)


@router.get("/events")
async def events(request: Request, after: int = Query(default=0, ge=0, le=9223372036854775807), run_id: int | None = Query(default=None, gt=0, le=9223372036854775807), last_event_id: Annotated[str | None, Header()] = None):
    if last_event_id is not None:
        try:
            parsed = int(last_event_id)
            if parsed < 0 or parsed > 9223372036854775807:
                raise ValueError("Cursor fora do limite")
            after = max(after, parsed)
        except ValueError as exc:
            raise HTTPException(422, "Last-Event-ID inválido.") from exc
    if after < 0 or after > 9223372036854775807:
        raise HTTPException(422, "Cursor inválido.")

    async def stream():
        cursor = after
        heartbeat = 0
        yield "retry: 2000\n\n"
        while not await request.is_disconnected():
            rows = await run_in_threadpool(read_events, cursor, run_id)
            for event in rows:
                cursor = event.id
                yield encode_event(event)
            heartbeat += 1
            if heartbeat >= 20:
                yield ": heartbeat\n\n"
                heartbeat = 0
            await asyncio.sleep(0.5)

    return StreamingResponse(stream(), media_type="text/event-stream", headers={"Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no"})
