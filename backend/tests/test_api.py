from decimal import Decimal

import pytest
from sqlalchemy import select, func

from app.database import SessionLocal
from app.models import PurchaseRequest, Quote, RequestStatus, Supplier
from app.schemas import PurchaseRequestCreate
from app.services import persist_request


def test_request_runs_graph_and_updates_dashboard(legacy_client, supplier):
    response = legacy_client.post("/request", json={"item": "Monitor", "target_price": "100.00", "qty": 10}, headers={"Idempotency-Key": "purchase-1"})
    assert response.status_code == 201
    assert response.json()["status"] == "TODO"
    board = legacy_client.get("/kanban").json()
    row = board["DONE"][0]
    assert row["id"] == response.json()["id"]
    assert row["quote"]["initial_price"] == "120.00"
    assert row["quote"]["final_price"] == "100.00"
    assert row["quote"]["savings_achieved"] == "200.00"
    assert row["quote"]["negotiation_rounds"] == 2
    assert row["supplier"]["id"] == supplier["id"]
    assert row["created_at"].endswith("+00:00")
    assert legacy_client.get("/dashboard/metrics").json() == {"total_savings": "200.00", "average_discount_percentage": "16.67", "successful_negotiations_count": 1}
    retry = legacy_client.post("/request", json={"item": "Monitor", "target_price": "100.00", "qty": 10}, headers={"Idempotency-Key": "purchase-1"})
    assert retry.json()["id"] == row["id"]
    assert len(legacy_client.get("/kanban").json()["DONE"]) == 1
    conflict = legacy_client.post("/request", json={"item": "Outro monitor", "target_price": "100.00", "qty": 10}, headers={"Idempotency-Key": "purchase-1"})
    assert conflict.status_code == 409


def test_webhook_idempotency_auth_stock_and_negative_savings(legacy_client, supplier):
    request = persist_request(PurchaseRequestCreate(item="Peça", target_price="1.00", qty=3))
    payload = {"request_id": request.id, "supplier_id": supplier["id"], "initial_price": "0.33", "final_price": "0.34", "available_qty": 3, "delivery_time": "2 dias", "conditions": "À vista"}
    headers = {"X-Webhook-Secret": "test-secret"}
    assert legacy_client.post("/webhook/voice", json=payload).status_code == 401
    assert legacy_client.post("/webhook/voice", json={**payload, "available_qty": 2}, headers=headers).status_code == 422
    result = legacy_client.post("/webhook/voice", json=payload, headers=headers)
    assert result.status_code == 200
    assert result.json()["savings_achieved"] == "-0.03"
    assert legacy_client.post("/webhook/voice", json=payload, headers=headers).json() == result.json()
    assert legacy_client.post("/webhook/voice", json={**payload, "final_price": "0.30"}, headers=headers).status_code == 409
    assert legacy_client.get("/dashboard/metrics").json() == {"total_savings": "-0.03", "average_discount_percentage": "-3.03", "successful_negotiations_count": 0}
    with SessionLocal() as session:
        assert session.scalar(select(func.count(Quote.id))) == 1
        assert session.get(Supplier, supplier["id"]).memory_summary_vector_mock.count("Request ") == 1


@pytest.mark.parametrize("invalid", [{"qty": 0}, {"qty": True}, {"target_price": "NaN"}, {"target_price": "1.001"}, {"item": "  "}, {"supplier_id": 9999}])
def test_input_validation(legacy_client, supplier, invalid):
    response = legacy_client.post("/request", json={"item": "Item", "target_price": "10.00", "qty": 1, **invalid})
    assert response.status_code == 422


def test_empty_metrics_missing_supplier_and_cors(legacy_client):
    assert legacy_client.get("/dashboard/metrics").json() == {"total_savings": "0.00", "average_discount_percentage": "0.00", "successful_negotiations_count": 0}
    assert legacy_client.get("/kanban").json() == {"TODO": [], "CALLING": [], "NEGOTIATING": [], "DONE": []}
    assert legacy_client.post("/request", json={"item": "Item", "target_price": "1.00", "qty": 1}).status_code == 422
    response = legacy_client.options("/request", headers={"Origin": "http://localhost:3000", "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "Idempotency-Key"})
    assert response.headers["access-control-allow-origin"] == "http://localhost:3000"


def test_wrong_supplier_cannot_finalize_request(legacy_client, supplier):
    other = legacy_client.post("/supplier", json={"name": "Outro", "phone": "+5511888888888"}).json()
    request = persist_request(PurchaseRequestCreate(item="Item", target_price="10.00", qty=1))
    response = legacy_client.post("/webhook/voice", headers={"X-Webhook-Secret": "test-secret"}, json={"request_id": request.id, "supplier_id": other["id"], "initial_price": "12.00", "final_price": "10.00", "available_qty": 1, "delivery_time": "1 dia"})
    assert response.status_code == 409


def test_openapi_contract_includes_quote_and_decimal_strings(legacy_client):
    schemas = legacy_client.get("/openapi.json").json()["components"]["schemas"]
    request = schemas["PurchaseRequestRead"]["properties"]
    assert {"quote", "supplier", "last_error", "created_at", "updated_at"} <= request.keys()
    quote = schemas.get("QuoteRead-Output", schemas.get("QuoteRead"))
    assert quote["properties"]["savings_achieved"]["type"] == "string"
