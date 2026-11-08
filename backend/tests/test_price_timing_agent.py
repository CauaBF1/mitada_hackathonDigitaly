import asyncio
from datetime import date, timedelta
from decimal import Decimal
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import SecretStr, ValidationError

from app import price_timing_agent as timing

TODAY = date(2026, 11, 8)


def point(day=TODAY, price="100.00", supplier="Loja A"):
    return timing.PricePoint(date=day, price=price, supplier=supplier)


def payload(history=None, **kwargs):
    return timing.PriceTimingInput(item_name="Mouse Logitech G Pro", selected_price="90.00", price_source="selected", history=history or [], **kwargs)


def test_contract_forbids_unknown_fields_and_invalid_financial_data():
    with pytest.raises(ValidationError):
        timing.PriceTimingInput(**{**payload().model_dump(), "callback_url": "https://invalid"})
    for value in ("NaN", "Infinity", "0", "-1", "1.001"):
        with pytest.raises(ValidationError):
            point(price=value)
    report = asyncio.run(timing.PriceTimingAgent().analyze(payload(real_history()), TODAY)).analysis
    for changes in ({"current_price_percentile": 101}, {"confidence_score": -1}, {"extra": 1}):
        with pytest.raises(ValidationError):
            timing.PriceTimingReport.model_validate({**report.model_dump(), **changes})


def test_decimal_math_and_percentile_ties():
    stats = timing.statistics([point(TODAY-timedelta(days=i), "0.30") for i in range(8)], Decimal("0.27"))
    assert stats["savings_vs_historical_avg_pct"] == Decimal("10.00")
    assert stats["current_price_percentile"] == 0
    assert timing.statistics([point()], Decimal("100"))["current_price_percentile"] == 50
    assert timing.statistics([point()], Decimal("200"))["current_price_percentile"] == 100


def test_daily_average_balances_supplier_captures_but_minimum_is_real_observation():
    points = [point(price="80"), point(price="80"), point(price="120", supplier="Loja B")]
    assert timing.daily_prices(points) == [(TODAY, Decimal("100"))]
    stats = timing.statistics(points, Decimal("90"))
    assert stats["savings_vs_historical_avg_pct"] == Decimal("10")
    assert stats["lowest_historical_price"] == Decimal("80")
    assert stats["highest_historical_price"] == Decimal("120")


@pytest.mark.parametrize(("prices", "expected"), [([100]*9,"STABLE"), (list(range(100,190,10)),"RISING"), (list(range(190,100,-10)),"FALLING")])
def test_trends_compare_first_and_last_thirds(prices, expected):
    points = [point(TODAY-timedelta(days=8-i), str(value)) for i, value in enumerate(prices)]
    assert timing.statistics(points, Decimal("100"))["trend"] == expected


@pytest.mark.parametrize("days", [30,60,90])
def test_insufficient_history_stays_unknown_and_never_calls_model(days, monkeypatch):
    async def never(*args):
        raise AssertionError("Synthetic data must not invoke a buying model")
    monkeypatch.setattr(timing.PriceTimingAgent, "_invoke", never)
    p = payload([point(), point(TODAY-timedelta(days=days)), point(TODAY+timedelta(days=1))], days=days)
    result = asyncio.run(timing.PriceTimingAgent().analyze(p, TODAY))
    assert result.data_source == "unavailable"
    assert result.real_observation_count == 1
    assert len(result.history) == 1
    assert result.history[0].date == TODAY
    assert result.history == result.observed_history
    assert result.analysis is None
    assert result.historical_average is None
    assert result.analysis_source == "insufficient_data"
    assert "desconhecidos" in result.message


def test_missing_price_does_not_invent_current_price_or_report():
    p = timing.PriceTimingInput(item_name="Mouse", selected_price=None, price_source="unavailable")
    result = asyncio.run(timing.PriceTimingAgent().analyze(p, TODAY))
    assert result.analysis is None and result.history == [] and result.data_source == "unavailable"


def real_history():
    return [point(TODAY-timedelta(days=i), "100") for i in range(10)]


def test_real_data_model_failure_uses_explicit_statistical_fallback(monkeypatch):
    async def fail(*args):
        raise TimeoutError("provider unavailable")
    monkeypatch.setattr(timing.PriceTimingAgent, "_invoke", fail)
    result = asyncio.run(timing.PriceTimingAgent().analyze(payload(real_history()), TODAY))
    assert result.data_source == "persisted"
    assert result.analysis_source == "statistical_fallback"
    assert result.analysis.verdict == "BUY_NOW"
    assert result.historical_average == Decimal("100.00")
    assert result.analysis.savings_vs_historical_avg_pct == Decimal("10.00")


@pytest.mark.parametrize("provider", ["gemini", "groq"])
def test_llm_is_structured_and_cannot_override_math_or_confidence(monkeypatch, provider):
    calls = []
    class FakeLLM:
        def __init__(self, **kwargs):
            calls.append(kwargs)
        def with_structured_output(self, schema):
            assert schema is timing.PriceTimingReport
            return self
        async def ainvoke(self, messages):
            assert messages[0][0] == "system"
            return dict(trend="FALLING", verdict="MONITOR", savings_vs_historical_avg_pct="99", lowest_historical_price="1",
                        highest_historical_price="9999", current_price_percentile=90, confidence_score=100,
                        timing_justification="Os preços observados se mantêm estáveis. A escolha está abaixo da média; acompanhe novas cotações para confirmar a tendência.")
    monkeypatch.setattr(timing, "settings", SimpleNamespace(active_llm_api_key=SecretStr("fake"), active_llm_provider=provider, groq_model="llama-3.3-70b-versatile"))
    monkeypatch.setattr(timing, "ChatGoogleGenerativeAI", FakeLLM)
    monkeypatch.setattr(timing, "ChatGroq", FakeLLM)
    result = asyncio.run(timing.PriceTimingAgent().analyze(payload(real_history()), TODAY))
    assert calls[0]["model"] == ("gemini-2.5-flash" if provider == "gemini" else "llama-3.3-70b-versatile")
    assert result.analysis_source == "llm"
    assert result.analysis.trend == "STABLE" and result.analysis.current_price_percentile == 0
    assert result.analysis.lowest_historical_price == Decimal("100")
    assert result.analysis.savings_vs_historical_avg_pct == Decimal("10")
    assert result.analysis.confidence_score == 40


def test_internal_endpoint_auth_and_decimal_serialization(monkeypatch):
    monkeypatch.setenv("INTERNAL_API_TOKEN", "test-token")
    app = FastAPI()
    app.include_router(timing.router)
    with TestClient(app) as client:
        # A report requires seven or more real dates; a current quote alone
        # must leave the analysis unknown rather than synthesize history.
        body = payload(real_history()).model_dump(mode="json")
        assert client.post("/price-timing/analyze", json=body).status_code == 401
        response = client.post("/price-timing/analyze", json=body, headers={"Authorization": "Bearer test-token"})
        assert response.status_code == 200
        data = response.json()
        assert data["selected_price"] == "90.00"
        assert isinstance(data["analysis"]["lowest_historical_price"], str)
        assert data["history"][0]["date"].count("-") == 2
        assert client.post("/price-timing/analyze", json={**body, "days": 7}, headers={"Authorization": "Bearer test-token"}).status_code == 422


@pytest.mark.parametrize("retired", [True, False])
def test_gemini_replacement_only_for_retired_model(monkeypatch, retired):
    class GoogleModelNotFoundError(Exception):
        pass
    models = []
    class FakeLLM:
        def __init__(self, **kwargs):
            self.model = kwargs["model"]
            models.append(self.model)
        def with_structured_output(self, schema):
            assert schema is timing.PriceTimingReport
            return self
        async def ainvoke(self, messages):
            if self.model == "gemini-2.5-flash":
                raise GoogleModelNotFoundError() if retired else PermissionError()
            return dict(trend="STABLE",verdict="MONITOR",savings_vs_historical_avg_pct="10",lowest_historical_price="100",
                        highest_historical_price="100",current_price_percentile=0,confidence_score=35,
                        timing_justification="O preço está abaixo da média observada. Monitore o mercado para confirmar a vantagem.")
    monkeypatch.setattr(timing, "settings", SimpleNamespace(active_llm_api_key=SecretStr("fake"), active_llm_provider="gemini", gemini_model="configured-replacement"))
    monkeypatch.setattr(timing, "ChatGoogleGenerativeAI", FakeLLM)
    result = asyncio.run(timing.PriceTimingAgent().analyze(payload(real_history()), TODAY))
    assert models == (["gemini-2.5-flash", "configured-replacement"] if retired else ["gemini-2.5-flash"])
    assert result.analysis_source == ("llm" if retired else "statistical_fallback")
