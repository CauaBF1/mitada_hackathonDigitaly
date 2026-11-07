from decimal import Decimal, ROUND_HALF_UP

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from .database import SessionLocal
from .models import PurchaseRequest, Quote, RequestStatus, Supplier
from .schemas import (
    DashboardMetrics,
    KanbanRead,
    PurchaseRequestCreate,
    PurchaseRequestRead,
    QuoteRead,
    SupplierCreate,
    SupplierRead,
    VoiceWebhook,
)


CENT = Decimal("0.01")


def persist_supplier(payload: SupplierCreate) -> SupplierRead:
    try:
        with SessionLocal.begin() as session:
            supplier = Supplier(**payload.model_dump())
            session.add(supplier)
            session.flush()
            result = SupplierRead.model_validate(supplier)
        return result
    except IntegrityError as exc:
        raise HTTPException(409, "Já existe um fornecedor com este telefone.") from exc


def list_suppliers() -> list[SupplierRead]:
    with SessionLocal() as session:
        return [SupplierRead.model_validate(row) for row in session.scalars(select(Supplier).order_by(Supplier.name))]


def persist_request(payload: PurchaseRequestCreate, idempotency_key: str | None = None) -> PurchaseRequestRead:
    try:
        with SessionLocal.begin() as session:
            if idempotency_key:
                existing = session.scalar(select(PurchaseRequest).where(PurchaseRequest.client_request_id == idempotency_key))
                if existing:
                    fields = payload.model_dump(exclude={"supplier_id"})
                    if any(getattr(existing, key) != value for key, value in fields.items()) or (
                        payload.supplier_id is not None and existing.supplier_id != payload.supplier_id
                    ):
                        raise HTTPException(409, "Esta chave já foi usada para outra solicitação.")
                    return PurchaseRequestRead.model_validate(existing)
            supplier = (
                session.get(Supplier, payload.supplier_id)
                if payload.supplier_id is not None
                else session.scalar(select(Supplier).order_by(Supplier.id).limit(1))
            )
            if supplier is None:
                raise HTTPException(422, "Cadastre um fornecedor antes de criar uma solicitação.")
            request = PurchaseRequest(
                **payload.model_dump(exclude={"supplier_id"}),
                supplier=supplier,
                client_request_id=idempotency_key,
                status=RequestStatus.TODO,
            )
            session.add(request)
            session.flush()
            result = PurchaseRequestRead.model_validate(request)
        return result
    except IntegrityError as exc:
        raise HTTPException(409, "Solicitação concorrente. Repita com a mesma chave.") from exc


def get_retry_request(request_id: int) -> PurchaseRequestRead:
    with SessionLocal() as session:
        request = session.get(PurchaseRequest, request_id)
        if request is None:
            raise HTTPException(404, "Solicitação não encontrada.")
        if request.status != RequestStatus.TODO:
            raise HTTPException(409, "A solicitação já está em andamento ou concluída.")
        return PurchaseRequestRead.model_validate(request)


def read_kanban() -> KanbanRead:
    columns = {state.value: [] for state in RequestStatus}
    with SessionLocal() as session:
        for request in session.scalars(select(PurchaseRequest).order_by(PurchaseRequest.id.desc())):
            columns[request.status.value].append(PurchaseRequestRead.model_validate(request))
    return KanbanRead.model_validate(columns)


def persist_voice_quote(payload: VoiceWebhook) -> QuoteRead:
    try:
        with SessionLocal.begin() as session:
            request = session.get(PurchaseRequest, payload.request_id)
            if request is None:
                raise HTTPException(404, "Solicitação não encontrada.")
            if request.supplier_id != payload.supplier_id:
                raise HTTPException(409, "O fornecedor não corresponde à solicitação.")
            existing = request.quote
            if existing is not None:
                if all(getattr(existing, key) == value for key, value in payload.model_dump().items()):
                    return QuoteRead.model_validate(existing)
                raise HTTPException(409, "A solicitação já possui uma cotação final.")
            if request.status == RequestStatus.DONE:
                raise HTTPException(409, "Solicitação já concluída.")
            if payload.available_qty < request.qty:
                raise HTTPException(422, "Quantidade disponível insuficiente.")
            quote = Quote(**payload.model_dump(), purchase_request=request)
            session.add(quote)
            request.status = RequestStatus.DONE
            request.last_error = None
            memory = (
                f"Request {request.id}: {request.item}; quantity={request.qty}; "
                f"initial_unit_price={payload.initial_price:.2f}; final_unit_price={payload.final_price:.2f}; "
                f"savings={quote.savings_achieved:.2f}; delivery={payload.delivery_time}; conditions={payload.conditions}"
            )
            request.supplier.memory_summary_vector_mock = (
                request.supplier.memory_summary_vector_mock + "\n" + memory
            ).strip()[-16000:]
            session.flush()
            result = QuoteRead.model_validate(quote)
        return result
    except IntegrityError as exc:
        raise HTTPException(409, "Cotação concorrente. Repita o webhook.") from exc


def read_metrics() -> DashboardMetrics:
    savings = Decimal(0)
    discounts = Decimal(0)
    count = 0
    successful = 0
    with SessionLocal() as session:
        quotes = session.scalars(
            select(Quote).join(Quote.purchase_request).where(PurchaseRequest.status == RequestStatus.DONE)
        )
        for quote in quotes:
            savings += quote.savings_achieved
            discounts += (quote.initial_price - quote.final_price) / quote.initial_price * 100
            count += 1
            successful += int(quote.final_price < quote.initial_price)
    return DashboardMetrics(
        total_savings=savings.quantize(CENT, rounding=ROUND_HALF_UP),
        average_discount_percentage=(discounts / count if count else Decimal(0)).quantize(CENT, rounding=ROUND_HALF_UP),
        successful_negotiations_count=successful,
    )
