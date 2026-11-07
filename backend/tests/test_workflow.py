from decimal import Decimal

import pytest

from app.database import SessionLocal
from app.main import initialize_database
from app.models import PurchaseRequest, RequestStatus
from app.orchestrator_legacy import MockVoiceAgent, MockVoiceConfig, build_graph, fetch_memory, run_negotiation
from app.schemas import PurchaseRequestCreate
from app.services import persist_request


def create(item="Item"):
    return persist_request(PurchaseRequestCreate(item=item, target_price="100.00", qty=10))


def test_second_purchase_uses_history_and_completed_run_is_idempotent(legacy_client, supplier):
    first = create()
    result = run_negotiation(first.id)
    assert result["negotiation_rounds"] == 2
    assert run_negotiation(first.id)["quote_id"] == result["quote_id"]
    second = run_negotiation(create().id)
    assert second["historical_price"] == 100
    assert second["initial_price"] == 105
    assert second["negotiation_rounds"] == 1
    assert "Request " in second["supplier_memory"]
    assert "last agreed unit price" in second["counter_offer_script"]


@pytest.mark.parametrize("config,rounds,accepted", [
    (MockVoiceConfig(initial_markup=Decimal("0.90")), 0, True),
    (MockVoiceConfig(discount_per_round=Decimal("0")), 3, False),
])
def test_acceptance_and_round_limit(legacy_client, supplier, config, rounds, accepted):
    result = build_graph(MockVoiceAgent(config)).invoke({"request_id": create().id})
    assert result["negotiation_rounds"] == rounds
    assert result["accepted"] is accepted
    assert result["status"] == "DONE"
    assert result["termination_reason"] == ("target_met" if accepted else "max_rounds_reached")


def test_failure_returns_request_to_queue_and_retry_completes(legacy_client, supplier):
    class BrokenVoice(MockVoiceAgent):
        def initial_quote(self, state):
            raise RuntimeError("Provider unavailable")

    request = create()
    with pytest.raises(RuntimeError, match="Provider unavailable"):
        build_graph(BrokenVoice()).invoke({"request_id": request.id})
    with SessionLocal() as session:
        row = session.get(PurchaseRequest, request.id)
        assert row.status == RequestStatus.TODO
        assert row.last_error
    assert legacy_client.post(f"/request/{request.id}/retry").status_code == 202
    assert legacy_client.get("/kanban").json()["DONE"][0]["last_error"] is None
    assert legacy_client.post(f"/request/{request.id}/retry").status_code == 409


def test_duplicate_workflow_does_not_reset_an_active_request(legacy_client, supplier):
    request = create()
    fetch_memory({"request_id": request.id})
    with pytest.raises(RuntimeError, match="already running"):
        run_negotiation(request.id)
    with SessionLocal() as session:
        assert session.get(PurchaseRequest, request.id).status == RequestStatus.CALLING
    initialize_database()
    with SessionLocal() as session:
        assert session.get(PurchaseRequest, request.id).status == RequestStatus.TODO
        assert session.get(PurchaseRequest, request.id).last_error
