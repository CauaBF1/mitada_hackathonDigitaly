import pytest
from pydantic import ValidationError

from app import agent_service


def test_internal_task_contract_rejects_bad_quantity_and_unknown_fields():
    valid = dict(task_id="task-1", request_id="request-1", product="Notebook", qty=2, destination="01001-000", execution_version=3)
    assert agent_service.TaskRequest.model_validate(valid).qty == 2
    with pytest.raises(ValidationError):
        agent_service.TaskRequest.model_validate({**valid, "qty": 0})
    with pytest.raises(ValidationError):
        agent_service.TaskRequest.model_validate({**valid, "callback_url": "https://attacker.invalid"})


@pytest.mark.parametrize(("value", "allow_zero", "expected"), [
    ("123.45", False, 12345), ("0", True, 0), (None, True, None),
    ("0", False, None), ("1.001", True, None), ("NaN", True, None),
])
def test_market_money_is_validated_and_converted_to_integer_cents(value, allow_zero, expected):
    assert agent_service.to_cents(value, allow_zero=allow_zero) == expected


@pytest.mark.parametrize(("text", "expected"), [("R$ 19,99", 1999), ("1.10", 110), ("1.234,56", 123456), ("19.999", None)])
def test_decimal_text_is_converted_without_binary_float_rounding(text, expected):
    assert agent_service.quoted_cents(text, allow_zero=False) == expected


def test_callback_origin_allows_only_fixed_local_hosts_and_origin_only(monkeypatch):
    monkeypatch.setenv("NEST_API_URL", "http://api:4000")
    assert agent_service.callback_base_url() == "http://api:4000"
    for value in ("https://api:4000", "http://api:4000/path", "http://attacker.example", "http://user@api:4000"):
        monkeypatch.setenv("NEST_API_URL", value)
        with pytest.raises(RuntimeError):
            agent_service.callback_base_url()


def test_langgraph_declares_four_ordered_processing_nodes():
    nodes = agent_service.graph_builder.nodes
    assert {"research", "prepare", "parse", "analysis"} <= set(nodes)
