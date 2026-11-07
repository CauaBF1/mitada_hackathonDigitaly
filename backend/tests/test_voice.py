import json
from copy import deepcopy
from pathlib import Path
from uuid import UUID

import pytest
from sqlalchemy import func, select

from app.database import SessionLocal
from app.models import PurchaseRequest, Quote, RequestStatus, Supplier, VoiceCall
from app.schemas import PurchaseRequestCreate
from app.services import persist_request
from app.voice_config_and_webhook import (
    OUTPUT_NAME,
    TOOL_NAME,
    VOICE_AGENT_CONFIG,
    build_voice_agent_config,
    mock_outbound_call,
)


ASSISTANT_ID = UUID("00000000-0000-4000-8000-000000000001")
PHONE_ID = UUID("00000000-0000-4000-8000-000000000002")
AUTH = {"Authorization": "Bearer test-secret"}


@pytest.fixture
def call(legacy_client, supplier):
    request = persist_request(PurchaseRequestCreate(item="Monitor", target_price="100.00", qty=3))
    return mock_outbound_call(request.id, ASSISTANT_ID, PHONE_ID)


@pytest.fixture
def quote():
    return {
        "initial_price": "120.00", "final_price": "100.00", "qty": 5,
        "delivery_time": "5 dias úteis após a ordem de compra",
        "conditions": "Pagamento em 30 dias, impostos e frete inclusos.",
        "negotiation_rounds": 2, "currency": "BRL", "price_basis": "unit", "supplier_confirmed": True,
    }


def envelope(call, event="end-of-call-report", **fields):
    return {"message": {"type": event, "call": {"id": call.id, "metadata": call.payload["metadata"]}, **fields}}


def tool(quote, name=TOOL_NAME, tool_id="tool-1", as_string=False):
    return {"id": tool_id, "type": "function", "function": {"name": name, "arguments": json.dumps(quote) if as_string else quote}}


def post(legacy_client, payload, headers=AUTH):
    return legacy_client.post("/webhook/voice", json=payload, headers=headers)


def test_config_file_schema_and_server_configuration():
    path = Path(__file__).resolve().parents[1] / "voice" / "voice_agent_config.json"
    assert json.loads(path.read_text()) == VOICE_AGENT_CONFIG
    config = build_voice_agent_config("https://example.com/webhook/voice", "credential-id", "output-id")
    assert config["server"] == {"url": "https://example.com/webhook/voice", "credentialId": "credential-id"}
    assert config["artifactPlan"]["structuredOutputIds"] == ["output-id"]
    assert config["model"]["tools"][0]["function"]["name"] == TOOL_NAME
    assert "server" not in VOICE_AGENT_CONFIG
    assert "request_id" not in config["model"]["tools"][0]["function"]["parameters"]["properties"]


def test_mock_trigger_is_idempotent_and_does_not_complete_purchase(legacy_client, call):
    repeated = mock_outbound_call(call.payload["metadata"]["request_id"], ASSISTANT_ID, PHONE_ID)
    assert repeated.id == call.id and call.mocked is True
    assert "assistant" not in call.payload
    assert "server" not in call.payload["assistantOverrides"]
    context = json.loads(call.payload["assistantOverrides"]["variableValues"]["purchase_context"])
    assert context["requested_qty"] == 3 and context["target_price"] == "100.00"
    with SessionLocal() as session:
        assert session.get(PurchaseRequest, call.payload["metadata"]["request_id"]).status == RequestStatus.CALLING
        assert session.scalar(select(func.count(Quote.id))) == 0


@pytest.mark.parametrize("as_string", [True, False])
def test_function_call_stages_then_end_report_finalizes_once(legacy_client, call, quote, as_string):
    staged = post(legacy_client, envelope(call, "tool-calls", toolCallList=[tool(quote, as_string=as_string)]))
    assert staged.status_code == 200, staged.text
    result = staged.json()["results"][0]
    assert result["toolCallId"] == "tool-1"
    assert json.loads(result["result"])["status"] == "recorded"
    assert legacy_client.get("/kanban").json()["DONE"] == []
    response = post(legacy_client, envelope(call))
    assert response.status_code == 200, response.text
    assert response.json()["quote"]["savings_achieved"] == "60.00"
    assert response.json()["quote"]["available_qty"] == 5
    assert post(legacy_client, envelope(call)).json() == response.json()
    with SessionLocal() as session:
        assert session.scalar(select(func.count(Quote.id))) == 1
        assert session.get(VoiceCall, call.id).status == "completed"
        assert session.get(Supplier, call.payload["metadata"]["supplier_id"]).memory_summary_vector_mock.count("Request ") == 1
    assert legacy_client.get("/dashboard/metrics").json()["total_savings"] == "60.00"


@pytest.mark.parametrize("source", ["structured", "call_artifact", "legacy", "toolCalls", "tool_calls"])
def test_end_report_extraction_sources(legacy_client, call, quote, source):
    payload = envelope(call)
    if source == "legacy":
        payload["message"]["analysis"] = {"structuredData": quote}
    elif source in {"toolCalls", "tool_calls"}:
        payload["message"]["artifact"] = {"messages": [{"role": "assistant", source: [tool(quote, as_string=True)]}]}
    else:
        artifact = {"structuredOutputs": {"output-id": {"name": OUTPUT_NAME, "result": quote}, "other-output": {"name": "unrelated_score", "result": 99}}}
        if source == "call_artifact":
            payload["message"]["call"]["artifact"] = artifact
            payload["message"]["call"]["metadata"] = None
        else:
            payload["message"]["artifact"] = artifact
    response = post(legacy_client, payload)
    assert response.status_code == 200, response.text
    assert response.json()["quote"]["final_price"] == "100.00"


@pytest.mark.parametrize("invalid", [
    {"initial_price": "NaN"}, {"final_price": "Infinity"}, {"final_price": "1.234"},
    {"initial_price": "R$ 1.234,56"}, {"qty": True}, {"qty": -1},
    {"supplier_confirmed": False}, {"supplier_confirmed": "true"},
    {"currency": "USD"}, {"price_basis": "total"}, {"negotiation_rounds": 4},
    {"conditions": " "}, {"request_id": 999}, {"available_qty": 999},
])
def test_invalid_quotes_never_complete_requests(legacy_client, call, quote, invalid):
    quote.update(invalid)
    response = post(legacy_client, envelope(call, analysis={"structuredData": quote}))
    assert response.status_code == 422, response.text
    assert legacy_client.get("/kanban").json()["DONE"] == []


def test_authentication_metadata_and_call_binding(legacy_client, call, quote):
    payload = envelope(call, analysis={"structuredData": quote})
    assert post(legacy_client, payload, {}).status_code == 401
    assert post(legacy_client, payload, {"X-Vapi-Secret": "wrong"}).status_code == 401
    assert post(legacy_client, payload, {**AUTH, "X-Webhook-Secret": "wrong"}).status_code == 401
    bad_metadata = deepcopy(payload)
    bad_metadata["message"]["call"]["metadata"]["request_id"] += 1
    assert post(legacy_client, bad_metadata).status_code == 409
    unknown = deepcopy(payload)
    unknown["message"]["call"]["id"] = "unknown-call"
    assert post(legacy_client, unknown).status_code == 404
    assert post(legacy_client, payload, {"X-Vapi-Secret": "test-secret"}).status_code == 200


def test_missing_structured_data_does_not_parse_transcript(legacy_client, call):
    response = post(legacy_client, envelope(call, artifact={"transcript": "Initial price 120, final 100, three units, five days"}))
    assert response.status_code == 200
    assert response.json()["status"] == "awaiting_data"
    row = legacy_client.get("/kanban").json()["TODO"][0]
    assert row["quote"] is None and row["last_error"]


def test_bad_tool_arguments_return_tool_result_without_finalizing(legacy_client, call, quote):
    bad = tool(quote)
    bad["function"]["arguments"] = '{"initial_price":"120","initial_price":"10"}'
    response = post(legacy_client, envelope(call, "tool-calls", toolCallList=[bad]))
    assert response.status_code == 200
    assert json.loads(response.json()["results"][0]["result"])["status"] == "error"
    assert post(legacy_client, envelope(call)).json()["status"] == "awaiting_data"


def test_invalid_latest_quote_blocks_stale_cached_quote(legacy_client, call, quote):
    post(legacy_client, envelope(call, "tool-calls", toolCallList=[tool(quote)]))
    bad = {**quote, "supplier_confirmed": False}
    post(legacy_client, envelope(call, "tool-calls", toolCallList=[tool(bad, tool_id="tool-2")]))
    assert post(legacy_client, envelope(call)).json()["status"] == "awaiting_data"
    assert legacy_client.get("/kanban").json()["DONE"] == []
    valid = post(legacy_client, envelope(call, analysis={"structuredData": quote}))
    assert valid.json()["status"] == "completed"


def test_malformed_final_tool_is_not_replaced_by_valid_analysis(legacy_client, call, quote):
    bad = tool({**quote, "final_price": "unknown"})
    payload = envelope(call, artifact={"messages": [{"toolCalls": [bad]}]}, analysis={"structuredData": quote})
    assert post(legacy_client, payload).status_code == 422


def test_conflicting_final_report_and_insufficient_stock(legacy_client, call, quote):
    assert post(legacy_client, envelope(call, analysis={"structuredData": {**quote, "qty": 2}})).status_code == 422
    assert post(legacy_client, envelope(call, analysis={"structuredData": quote})).status_code == 200
    assert post(legacy_client, envelope(call, analysis={"structuredData": {**quote, "final_price": "90.00"}})).status_code == 409


def test_zero_final_price_is_preserved(legacy_client, call, quote):
    response = post(legacy_client, envelope(call, analysis={"structuredData": {**quote, "final_price": 0}}))
    assert response.status_code == 200
    assert response.json()["quote"]["final_price"] == "0.00"
    assert response.json()["quote"]["savings_achieved"] == "360.00"


def test_tool_with_tool_call_list_and_unrelated_events(legacy_client, call, quote):
    payload = envelope(call, "tool-calls", toolWithToolCallList=[{"toolCall": tool(quote)}])
    assert json.loads(post(legacy_client, payload).json()["results"][0]["result"])["status"] == "recorded"
    assert post(legacy_client, envelope(call, "status-update", status="ended")).json()["status"] == "ignored"
    assert legacy_client.get("/kanban").json()["DONE"] == []


def test_openapi_supports_native_and_normalized_payloads(legacy_client):
    endpoint = legacy_client.get("/openapi.json").json()["paths"]["/webhook/voice"]["post"]
    schemas = endpoint["requestBody"]["content"]["application/json"]["schema"]["anyOf"]
    assert {schema["$ref"].rsplit("/", 1)[-1] for schema in schemas} == {"VoiceWebhook", "VapiEnvelope"}
    assert "authorization" in {parameter["name"] for parameter in endpoint["parameters"]}


def test_stale_tool_retry_does_not_replace_latest_quote(legacy_client, call, quote):
    post(legacy_client, envelope(call, "tool-calls", toolCallList=[tool(quote)]))
    stale = {**quote, "final_price": "108.00", "negotiation_rounds": 1}
    result = post(legacy_client, envelope(call, "tool-calls", toolCallList=[tool(stale, tool_id="older-tool")])).json()
    assert json.loads(result["results"][0]["result"])["status"] == "ignored_stale"
    assert post(legacy_client, envelope(call)).json()["quote"]["final_price"] == "100.00"
