import asyncio
from decimal import Decimal
import pytest
from pydantic import SecretStr

from app import agent, agent_intelligence
from app.agent_intelligence import (
    NEGOTIATOR_AGENT_PROMPT,
    NEGOTIATOR_SAUDE_PROMPT,
    NegotiatorResponse,
    TacticalSummary,
    negotiator_intelligence,
)
from app.orchestrator import PurchaseInput, create_purchase
from app.agent import NewPurchase, current_agent_name, conversational


def test_mariana_profile_prompt_is_selected_by_default(monkeypatch):
    from app.config import settings

    captured = {}

    class FakeModel:
        def __init__(self, **kwargs):
            pass

        def with_structured_output(self, schema, method):
            return self

        async def ainvoke(self, messages):
            captured["system_prompt"] = messages[0][1]
            return NegotiatorResponse(
                raciocinio_tatico=TacticalSummary(
                    tco_oferta_atual=Decimal("150.00"),
                    distancia_meta_pct=Decimal("-5.00"),
                    estrategia_aplicada="SOLICITAR_COTACAO",
                ),
                mensagem_telegram="Olá, sou Mariana da Nexo. Confirma conformidade técnica, estoque e prazo?",
            )

    monkeypatch.setattr(settings, "llm_provider", "gemini")
    monkeypatch.setattr(settings, "gemini_api_key", SecretStr("test-key"))
    monkeypatch.setattr(agent_intelligence, "ChatGoogleGenerativeAI", FakeModel)

    # 1. Default (no profile specified in data) -> uses Mariana (saúde)
    res = asyncio.run(negotiator_intelligence("gemini-test", {"item": "Luvas cirúrgicas"}))
    assert captured["system_prompt"] == NEGOTIATOR_SAUDE_PROMPT
    assert "Mariana" in captured["system_prompt"]
    assert "Suprimentos Hospitalares" in captured["system_prompt"]
    assert res.mensagem_telegram.startswith("Olá, sou Mariana")

    # 2. Explicit saude profile -> uses Mariana
    res_saude = asyncio.run(negotiator_intelligence("gemini-test", {"item": "Gaze", "profile": "saude"}))
    assert captured["system_prompt"] == NEGOTIATOR_SAUDE_PROMPT

    # 3. Explicit industria_varejo profile -> uses Roberto
    res_roberto = asyncio.run(negotiator_intelligence("gemini-test", {"item": "Monitores", "profile": "industria_varejo"}))
    assert captured["system_prompt"] == NEGOTIATOR_AGENT_PROMPT
    assert "Roberto" in captured["system_prompt"]


def test_conversational_filters_mariana_prefix():
    # Valid message
    assert conversational("Olá, sou Mariana da Nexo. Pode confirmar prazo de entrega e frete?") is not None
    # Invalid: prefix Mariana:
    assert conversational("Mariana: Olá, confirmo a cotação.") is None
    # Invalid: prefix Roberto:
    assert conversational("Roberto: Olá, confirmo a cotação.") is None


def test_current_agent_name():
    assert current_agent_name({"profile": "saude"}) == "Mariana"
    assert current_agent_name({"profile": "mariana"}) == "Mariana"
    assert current_agent_name({"profile": "hospitalar"}) == "Mariana"
    assert current_agent_name({"profile": "industria_varejo"}) == "Roberto"
    assert current_agent_name({}) == "Mariana"


def test_purchase_models_support_profile():
    p1 = PurchaseInput(item="Máscaras N95", qty=50)
    assert p1.profile == "saude"

    p2 = PurchaseInput(item="Notebook Dell", qty=10, profile="industria_varejo")
    assert p2.profile == "industria_varejo"

    np = NewPurchase(item="Seringas Descartáveis", qty=100)
    assert np.profile == "saude"
