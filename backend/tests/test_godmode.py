import asyncio
import json
from decimal import Decimal

import pytest
from sqlalchemy import func, select
from starlette.requests import Request

from app.database import SessionLocal
from app.models import PurchaseRequest, Quote, Supplier
from app import orchestrator_simulation as god


@pytest.fixture
def vendors(legacy_client):
    return [legacy_client.post("/supplier", json={"name": f"Fornecedor {index}", "phone": f"+55119999000{index}"}).json() for index in range(4)]


def start(legacy_client, **overrides):
    response = legacy_client.post("/godmode/request", json={"item": "Monitor QHD", "reference_price": "100.00", "qty": 3, **overrides}, headers={"Idempotency-Key": "auction-1"})
    assert response.status_code == 201, response.text
    return response.json()


def test_auction_end_to_end_metrics_and_idempotency(legacy_client, vendors):
    created = start(legacy_client)
    dashboard = legacy_client.get("/godmode/dashboard").json()
    run = dashboard["runs"][0]
    assert run["status"] == "completed"
    assert run["market_average"] == "120.00"
    assert run["target_price"] == "102.00"
    assert [source["unit_price"] for source in run["sources"]] == ["110.00", "120.00", "130.00"]
    assert len(run["bids"]) == 3
    assert run["assessments"][-1]["approved"] is False
    assert vendors[-1]["id"] not in [bid["supplier_id"] for bid in run["bids"]]
    winner = next(bid for bid in run["bids"] if bid["supplier_id"] == run["winner_id"])
    assert winner["initial_price"] == "122.40"
    assert winner["final_price"] == "115.25"
    assert run["hard_savings"] == "21.45"
    assert run["cost_avoidance"] == "14.25"
    assert dashboard["metrics"]["hard_savings"] == "21.45"
    assert dashboard["metrics"]["cost_avoidance"] == "14.25"
    assert dashboard["metrics"]["final_spend"] == "345.75"
    assert dashboard["metrics"]["completed_count"] == 1
    assert dashboard["metrics"]["active_count"] == 0
    assert start(legacy_client)["id"] == created["id"]
    assert legacy_client.post("/godmode/request", json={"item": "Other", "reference_price": "100", "qty": 3}, headers={"Idempotency-Key": "auction-1"}).status_code == 409
    with SessionLocal() as session:
        assert session.scalar(select(func.count()).select_from(Quote)) == 1
        purchase = session.get(PurchaseRequest, run["request_id"])
        assert purchase.supplier_id == winner["supplier_id"]
        assert purchase.quote.savings_achieved == Decimal("21.45")
        assert purchase.target_price == Decimal("102.00")
        assert session.get(Supplier, winner["supplier_id"]).memory_summary_vector_mock.count("Leilão simulado") == 1
    assert legacy_client.get("/kanban").json()["DONE"][0]["quote"]["final_price"] == "115.25"


def test_parallel_dispatch_is_concurrent_and_rejects_unapproved(legacy_client, vendors, monkeypatch):
    active = 0
    peak = 0
    original = god.mock_initial_call

    async def monitored(state, supplier, index):
        nonlocal active, peak
        active += 1
        peak = max(peak, active)
        try:
            await asyncio.sleep(0.03)
            return await original(state, supplier, index)
        finally:
            active -= 1

    monkeypatch.setattr(god, "mock_initial_call", monitored)
    start(legacy_client)
    assert peak == 3


def test_insufficient_approved_vendors_blocks_all_calls(legacy_client, supplier, monkeypatch):
    async def unexpected(*args):
        pytest.fail("Voice must not be invoked without three approved suppliers")
    monkeypatch.setattr(god, "mock_initial_call", unexpected)
    start(legacy_client)
    row = legacy_client.get("/godmode/dashboard").json()["runs"][0]
    assert row["status"] == "failed"
    assert "3 fornecedores" in row["error"]
    assert row["bids"] == []
    assert legacy_client.get("/dashboard/metrics").json()["total_savings"] == "0.00"


def test_repeated_purchase_uses_winner_history(legacy_client, vendors):
    start(legacy_client)
    assert legacy_client.post("/godmode/request", json={"item": "Monitor QHD", "reference_price": "100.00", "qty": 3}).status_code == 201
    run = legacy_client.get("/godmode/dashboard").json()["runs"][0]
    assert any(bid["memory_used"] for bid in run["bids"])


def test_partial_call_failure_continues_but_all_failures_are_visible(legacy_client, vendors, monkeypatch):
    original = god.mock_initial_call
    async def partial(state, supplier, index):
        if index == 0:
            raise RuntimeError("Provider unavailable")
        return await original(state, supplier, index)
    monkeypatch.setattr(god, "mock_initial_call", partial)
    start(legacy_client)
    assert legacy_client.get("/godmode/dashboard").json()["runs"][0]["status"] == "completed"
    assert len(legacy_client.get("/godmode/dashboard").json()["runs"][0]["bids"]) == 2
    async def failed(*args):
        raise RuntimeError("Provider unavailable")
    monkeypatch.setattr(god, "mock_initial_call", failed)
    legacy_client.post("/godmode/request", json={"item": "No offers", "reference_price": "100", "qty": 1})
    assert legacy_client.get("/godmode/dashboard").json()["runs"][0]["status"] == "failed"
    assert legacy_client.get("/godmode/dashboard").json()["metrics"]["completed_count"] == 1


def test_no_stock_offer_cannot_win(legacy_client, vendors, monkeypatch):
    original = god.mock_initial_call
    async def no_stock(state, supplier, index):
        bid = await original(state, supplier, index)
        return bid.model_copy(update={"available_qty": 0})
    monkeypatch.setattr(god, "mock_initial_call", no_stock)
    start(legacy_client)
    assert legacy_client.get("/godmode/dashboard").json()["runs"][0]["status"] == "failed"


def test_events_are_ordered_replayable_and_streamed(legacy_client, vendors):
    created = start(legacy_client)
    history = legacy_client.get(f"/godmode/events/history?run_id={created['id']}").json()
    ids = [event["id"] for event in history]
    assert ids == sorted(set(ids))
    assert history[0]["stage"] == "queued"
    assert history[-1]["stage"] == "completed"
    after = history[5]["id"]
    assert legacy_client.get(f"/godmode/events/history?after={after}&run_id={created['id']}").json() == history[6:]
    async def read_stream():
        async def receive():
            await asyncio.sleep(3600)
        request = Request({"type": "http", "method": "GET", "path": "/godmode/events", "headers": []}, receive)
        response = await god.events(request, after=0, run_id=created["id"], last_event_id=str(after))
        iterator = response.body_iterator
        assert await anext(iterator) == "retry: 2000\n\n"
        frame = await anext(iterator)
        assert f"id: {history[6]['id']}\n" in frame
        assert "event: log\n" in frame
        assert json.loads(frame.split("data: ")[1]) == history[6]
        await iterator.aclose()
    asyncio.run(read_stream())
    assert legacy_client.get("/godmode/events", headers={"Last-Event-ID": "bad"}).status_code == 422


def test_recovery_marks_interrupted_runs_failed_without_savings(legacy_client, vendors):
    run = god.create_auction(god.AuctionCreate(item="Pending", reference_price="10", qty=1), None)
    assert god.claim_auction(run.id)
    assert god.claim_auction(run.id) is None
    god.recover_auctions()
    result = god.read_dashboard()
    assert result.runs[0].status == "failed"
    assert result.metrics.hard_savings == 0
    assert god.read_events(0)[-1].stage == "failed"


@pytest.mark.parametrize("invalid", [{"qty": True}, {"qty": 0}, {"reference_price": "NaN"}, {"reference_price": "1.001"}, {"item": " "}])
def test_auction_validation(legacy_client, vendors, invalid):
    assert legacy_client.post("/godmode/request", json={"item": "Monitor", "reference_price": "100", "qty": 1, **invalid}).status_code == 422


def test_empty_metrics_and_money_limits(legacy_client, vendors):
    assert legacy_client.get("/godmode/dashboard").json()["metrics"]["completed_count"] == 0
    start(legacy_client, reference_price="9999999999.99", qty=1000000)
    row = legacy_client.get("/godmode/dashboard").json()["runs"][0]
    assert row["status"] == "completed"
    assert all(Decimal(source["unit_price"]) <= god.MAX_MONEY for source in row["sources"])
