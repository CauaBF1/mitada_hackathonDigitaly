from typing import Annotated

from fastapi import APIRouter, BackgroundTasks, Header
from starlette.concurrency import run_in_threadpool

from .. import services
from ..orchestrator_legacy import process_purchase_request
from ..schemas import (
    DashboardMetrics,
    KanbanRead,
    PurchaseRequestCreate,
    PurchaseRequestRead,
    SupplierCreate,
    SupplierRead,
)


router = APIRouter()


@router.get("/health")
async def health() -> dict:
    return {"status": "ok", "voice_mode": "mock", "currency": "BRL"}


@router.post("/supplier", response_model=SupplierRead, status_code=201)
async def create_supplier(payload: SupplierCreate):
    return await run_in_threadpool(services.persist_supplier, payload)


@router.get("/suppliers", response_model=list[SupplierRead])
async def get_suppliers():
    return await run_in_threadpool(services.list_suppliers)


@router.post("/request", response_model=PurchaseRequestRead, status_code=201)
async def create_request(
    payload: PurchaseRequestCreate,
    background_tasks: BackgroundTasks,
    idempotency_key: Annotated[str | None, Header(min_length=1, max_length=64)] = None,
):
    request = await run_in_threadpool(services.persist_request, payload, idempotency_key)
    if request.status == "TODO":
        background_tasks.add_task(process_purchase_request, request.id)
    return request


@router.post("/request/{request_id}/retry", response_model=PurchaseRequestRead, status_code=202)
async def retry_request(request_id: int, background_tasks: BackgroundTasks):
    request = await run_in_threadpool(services.get_retry_request, request_id)
    background_tasks.add_task(process_purchase_request, request.id)
    return request


@router.get("/kanban", response_model=KanbanRead)
async def get_kanban():
    return await run_in_threadpool(services.read_kanban)


@router.get("/dashboard/metrics", response_model=DashboardMetrics)
async def dashboard_metrics():
    return await run_in_threadpool(services.read_metrics)
