import pytest
import asyncio
import httpx
from pydantic import ValidationError
from decimal import Decimal
from types import SimpleNamespace

from app import agent_service

_ORIGINAL_HTTPX_CLIENT = httpx.AsyncClient


def _internal_api_request(method, path, *, headers=None, json_body=None):
    async def send():
        async with _ORIGINAL_HTTPX_CLIENT(transport=httpx.ASGITransport(app=agent_service.app), base_url="http://test") as client:
            return await client.request(method, path, headers=headers, json=json_body)
    return asyncio.run(send())


def test_search_integration_requires_internal_token_for_get_and_post(monkeypatch):
    monkeypatch.setenv("INTERNAL_API_TOKEN", "test-internal-token")
    get_response = _internal_api_request("GET", "/integrations/search")
    post_response = _internal_api_request(
        "POST", "/integrations/search", json_body={"api_key": "tvly-test-credential"},
    )
    assert get_response.status_code == 401
    assert post_response.status_code == 401


def test_search_integration_get_returns_provider_status_with_token(monkeypatch):
    from app import search_provider

    monkeypatch.setenv("INTERNAL_API_TOKEN", "test-internal-token")
    async def fake_status():
        return search_provider.SearchConnection(configured=False, active_provider="public", message="Busca pública")
    monkeypatch.setattr(search_provider, "status", fake_status)
    response = _internal_api_request(
        "GET", "/integrations/search", headers={"Authorization": "Bearer test-internal-token"},
    )
    assert response.status_code == 200
    assert response.json()["active_provider"] == "public"
    assert "api_key" not in response.json()


def test_search_integration_post_preserves_origin_checks_and_never_returns_credential(monkeypatch):
    import httpx
    from app import search_provider

    monkeypatch.setenv("INTERNAL_API_TOKEN", "test-internal-token")
    monkeypatch.setattr(search_provider.settings, "cors_origins", "https://local.test")
    headers = {"Authorization": "Bearer test-internal-token", "Origin": "https://local.test", "X-Nexo-Settings": "1"}
    body = {"api_key": "tvly-test-credential"}

    bad_origin = _internal_api_request("POST", "/integrations/search", headers={**headers, "Origin": "https://other.test"}, json_body=body)
    bad_settings = _internal_api_request("POST", "/integrations/search", headers={**headers, "X-Nexo-Settings": "0"}, json_body=body)

    tavily_calls = []
    def tavily_response(request):
        tavily_calls.append(request.url.path)
        return httpx.Response(200, json={
            "key": {"usage": 1, "limit": 1000},
            "account": {"current_plan": "free", "plan_usage": 1, "plan_limit": 1000,
                        "paygo_usage": 0, "paygo_limit": 0},
        })
    real_client = httpx.AsyncClient
    monkeypatch.setattr(search_provider.httpx, "AsyncClient", lambda **kwargs: real_client(transport=httpx.MockTransport(tavily_response), **kwargs))
    monkeypatch.setattr(search_provider, "save_key", lambda key: None)
    async def fake_run_in_threadpool(function, *args):
        return function(*args)
    monkeypatch.setattr(search_provider, "run_in_threadpool", fake_run_in_threadpool)
    valid = _internal_api_request("POST", "/integrations/search", headers=headers, json_body=body)
    invalid_credential = _internal_api_request("POST", "/integrations/search", headers=headers, json_body={"api_key": "not-a-tavily-key"})

    assert bad_origin.status_code == 403
    assert bad_settings.status_code == 403
    assert valid.status_code == 200
    assert valid.json()["active_provider"] == "tavily"
    assert "api_key" not in valid.json()
    assert "tvly-test-credential" not in valid.text
    assert tavily_calls == ["/usage"]
    assert invalid_credential.status_code == 422


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


def test_research_collects_one_verified_reputation_per_unique_domain(monkeypatch):
    from app.scraper_tools import ProductOffer, Reputation
    product = ProductOffer(supplier_name="Loja", supplier_domain="loja.example", supplier_website="https://loja.example",
        product_name="Item", product_url="https://loja.example/p", price=Decimal("12.50"), availability="in stock",
        observed_at="2026-01-01T00:00:00Z", extraction_method="schema.org/Product.offers", evidence_sha256="a" * 64)
    monkeypatch.setattr(agent_service, "discover_market", lambda query: _async_result(DiscoveryMock([product, product])))
    calls = []
    class Scraper:
        async def __aenter__(self): return self
        async def __aexit__(self, *args): pass
        async def reputation(self, supplier):
            calls.append(supplier.supplier_domain)
            return Reputation(supplier_domain=supplier.supplier_domain, company_name="Loja", url="https://www.reclameaqui.com.br/empresa/loja/",
                score=Decimal("8.2"), label="Boa", period="Últimos 6 meses", checked_at="2026-01-01T00:00:00Z", verified=True,
                approved=True, reason="Reputação verificada ≥ 6,0.", evidence_sha256="b" * 64)
    monkeypatch.setattr(agent_service, "MarketScraper", Scraper)
    result = asyncio.run(agent_service.research_node({"product":"Item", "task_id":"t1", "specs":{}}))
    assert calls == ["loja.example"]
    assert result["reputations"][0]["score"] == "8.2"
    assert result["reputations"][0]["verified"] is True


def test_research_timeout_keeps_reputation_score_null(monkeypatch):
    from app.scraper_tools import ProductOffer
    product = ProductOffer(supplier_name="Loja", supplier_domain="loja.example", supplier_website="https://loja.example",
        product_name="Item", product_url="https://loja.example/p", price=Decimal("12.50"), availability="in stock",
        observed_at="2026-01-01T00:00:00Z", extraction_method="schema.org/Product.offers", evidence_sha256="a" * 64)
    monkeypatch.setattr(agent_service, "discover_market", lambda query: _async_result(DiscoveryMock([product])))
    class Scraper:
        async def __aenter__(self): return self
        async def __aexit__(self, *args): pass
        async def reputation(self, supplier): raise TimeoutError
    monkeypatch.setattr(agent_service, "MarketScraper", Scraper)
    result = asyncio.run(agent_service.research_node({"product":"Item", "task_id":"t1", "specs":{}}))
    reputation = result["reputations"][0]
    assert reputation["score"] is None and reputation["verified"] is False
    assert "prazo" in reputation["reason"]


def test_conversation_contract_allows_partial_terms_and_rejects_invalid_cents():
    body = dict(product="Notebook", qty=1, destination="01001-000", message="Oi, tem 16 GB?", phase="quotation",
                history=[], terms={"unit_cents": None, "shipping_cents": 1200}, missing_fields=["prazo"])
    assert agent_service.ConversationTurnRequest.model_validate(body).terms["unit_cents"] is None
    with pytest.raises(ValidationError):
        agent_service.ConversationTurnRequest.model_validate({**body, "terms": {"unit_cents": 12.5}})
    with pytest.raises(ValidationError):
        agent_service.ConversationTurnRequest.model_validate({**body, "phase": "purchase!"})


@pytest.mark.parametrize(("phase", "intent", "terms", "acceptance"), [
    ("opening", "greeting", {}, "unclear"),
    ("quotation", "question_and_missing_fields", {"unit_cents": None}, "unclear"),
    ("quotation", "negation", {}, "unclear"),
    ("quotation", "correction", {"unit_cents": 123456}, "unclear"),
    ("quotation", "purchase_intent", {}, "unclear"),
])
def test_conversation_graph_passes_context_and_never_accepts_purchase_outside_purchase_phase(monkeypatch, phase, intent, terms, acceptance):
    from app.agent_intelligence import ConversationTurn
    seen = {}
    async def fake(model, data):
        seen.update(data)
        return ConversationTurn(intent=intent, reply="Certo. Qual prazo você precisa?", terms=terms,
                                explicit_confirmation=False, terms_changed=intent == "correction", purchase_acceptance="accepted")
    monkeypatch.setattr(agent_service, "conversation_intelligence", fake)
    state = {"product": "Notebook", "qty": 2, "destination": "01001-000", "message": "entrada",
             "history": [{"sender_type": "user", "content": "Oi"}], "phase": phase,
             "terms": {"unit_cents": None}, "missing_fields": ["prazo"]}
    result = asyncio.run(agent_service.conversation_turn_node(state))["result"]
    assert seen["phase"] == phase and seen["history"] == state["history"]
    assert result["intent"] == intent and result["purchase_acceptance"] == acceptance
    assert result["terms_changed"] is (intent == "correction")


def test_supplier_requirement_question_normalizes_empty_terms_and_ignores_model_changed_flag(monkeypatch):
    from app.agent_intelligence import ConversationTurn, CONVERSATION_PROMPT
    async def fake(model, data):
        return ConversationTurn(intent="supplier_question", reply="Vou confirmar a capacidade com o solicitante. Quais opções de DDR4 3200 vocês oferecem?",
                                terms={}, terms_changed=True, purchase_acceptance="unclear")
    monkeypatch.setattr(agent_service, "conversation_intelligence", fake)
    state = {"product": "RAM DDR4 3200", "qty": 7, "destination": "01001-000",
             "message": "Você precisa de quantos GB em cada pente?", "history": [], "phase": "quotation",
             "terms": None, "missing_fields": ["capacidade"]}
    result = asyncio.run(agent_service.conversation_turn_node(state))["result"]
    assert result["terms"] is None
    assert result["terms_changed"] is False
    assert "você é o COMPRADOR" in CONVERSATION_PROMPT
    assert "pergunte quais" in CONVERSATION_PROMPT


def test_conversation_rebuilds_canonical_terms_from_entire_supplier_history_without_claiming_api_state(monkeypatch):
    from app.agent_intelligence import ConversationTurn, CONVERSATION_PROMPT
    history = [
        {"sender_type": "supplier", "content": "R$ 980 por unidade, frete grátis, entrega em 5 dias."},
        {"sender_type": "supplier", "content": "Temos 10 unidades. Taxas adicionais ainda não confirmadas."},
        {"sender_type": "supplier", "content": "Pagamento por PIX ou cartão em até 12 vezes."},
    ]
    observed = {}
    async def fake(model, data):
        observed.update(data)
        return ConversationTurn(intent="quote_clarification", reply="Reuni todas as informações e estou encaminhando a cotação para avaliação.",
            terms={"supplier": "Loja Exemplo", "unit_cents": 98000, "shipping_cents": 0, "fees_cents": 3200,
                   "lead_days": 5, "available_qty": 10, "product_confirmed": False, "destination_confirmed": False,
                   "valid_until": "amanhã", "payment_terms": "PIX ou cartão em até 12 vezes"},
            terms_changed=False, purchase_acceptance="unclear")
    monkeypatch.setattr(agent_service, "conversation_intelligence", fake)
    result = asyncio.run(agent_service.conversation_turn_node({
        "product": "RAM DDR4 3200", "qty": 7, "destination": "01001-000",
        "message": "Consigo manter preço até amanhã", "history": history, "phase": "quotation",
        "terms": None, "missing_fields": [],
    }))["result"]
    assert observed["history"] == history
    assert result["terms"] == {"supplier": "Loja Exemplo", "unit_cents": 98000, "shipping_cents": 0,
        "lead_days": 5, "available_qty": 10, "valid_until": "amanhã", "payment_terms": "PIX ou cartão em até 12 vezes"}
    assert "fees_cents" not in result["terms"]
    assert "product_confirmed" not in result["terms"]
    assert "destination_confirmed" not in result["terms"]
    assert result["terms_changed"] is True
    assert "taxas adicionais" in result["reply"]
    assert "encaminhando" not in result["reply"]
    assert "todas as mensagens do fornecedor" in CONVERSATION_PROMPT
    assert "nunca invente taxas" in CONVERSATION_PROMPT.casefold()


@pytest.mark.parametrize(("text", "expected"), [
    ("Taxas adicionais ainda não confirmadas.", ("unknown", None)),
    ("Taxa adicional: R$ 32,00.", ("amount", 3200)),
    ("Não haverá taxas adicionais.", ("no_fees", 0)),
    ("Não tem taxa, aceito somente pix", ("no_fees", 0)),
    ("Nao tem taxas adicionais.", ("no_fees", 0)),
    ("Isento de taxas.", ("no_fees", 0)),
    ("Não há mais taxas", ("no_fees", 0)),
    ("Frete custa 35 reais, taxa de importação de 650 reais e consigo entregar em 3 dias", ("amount", 65000)),
    ("Frete custa 35 reais, taxa de importação de 650 reais e consigo entregar em 3 dias\nNão há mais taxas", ("amount", 65000)),
    ("Frete custa 35 reais, taxa de importação de 650 reais e consigo entregar em 3 dias\nNão há taxas adicionais", ("amount", 65000)),
    ("R$ 980 por unidade e frete grátis.", (None, None)),
])
def test_supplier_fee_evidence_never_infers_amount_from_other_quote_numbers(text, expected):
    assert agent_service.supplier_fee_evidence(text) == expected


def test_conversation_preserves_prior_quote_when_latest_message_only_adds_metadata(monkeypatch):
    from app.agent_intelligence import ConversationTurn
    prior = {"unit_cents": 98000, "shipping_cents": 0, "lead_days": 5, "available_qty": 10, "product_confirmed": False}
    async def fake(model, data):
        return ConversationTurn(intent="quote_clarification", reply="Qual forma de pagamento prefere?",
            terms={"valid_until": "amanhã", "payment_terms": "PIX ou cartão em até 12 vezes"})
    monkeypatch.setattr(agent_service, "conversation_intelligence", fake)
    result = asyncio.run(agent_service.conversation_turn_node({
        "product": "RAM DDR4 3200", "qty": 7, "destination": "01001-000", "message": "Consigo manter preço até amanhã",
        "history": [{"sender_type": "supplier", "content": "R$ 980 frete grátis, 5 dias e estoque 10."}],
        "phase": "quotation", "terms": prior, "missing_fields": [],
    }))["result"]
    assert result["terms"] == {**prior, "valid_until": "amanhã", "payment_terms": "PIX ou cartão em até 12 vezes"}
    assert result["terms"]["product_confirmed"] is False
    assert result["terms_changed"] is True


def test_reputation_refresh_keeps_ra_403_unverified_and_caches_search_indications(monkeypatch):
    from app import scraper_tools, search_provider
    calls = {"official": 0, "search": []}
    class Scraper:
        async def __aenter__(self): return self
        async def __aexit__(self, *args): pass
        async def reputation(self, offer):
            calls["official"] += 1
            raise scraper_tools.ScrapingError("HTTP 403")
    async def fake_search(query):
        calls["search"].append(query)
        return [{"title": "Relato público", "description": "Trecho de busca", "url": "https://www.reclameaqui.com.br/empresa/loja/"}]
    monkeypatch.setattr(scraper_tools, "MarketScraper", Scraper)
    monkeypatch.setattr(search_provider, "tavily_results", fake_search)
    monkeypatch.setattr(agent_service, "require_internal_token", lambda token: None)
    agent_service._reputation_cache.clear()
    payload = agent_service.ReputationRefreshRequest(offers=[{"source_url": "https://loja.com.br/item", "supplier": "Nome que não deve ser pesquisado"}])
    first = asyncio.run(agent_service.reputation_refresh(payload, None))
    second = asyncio.run(agent_service.reputation_refresh(payload, None))
    assert first["reputations"][0]["verified"] is False
    assert first["reputations"][0]["score"] is None
    assert first["reputation_indications"][0]["verified"] is False
    assert first["reputation_indications"][0]["url"] == "https://www.reclameaqui.com.br/empresa/loja/"
    assert first["reputation_indications"][0]["timestamp"]
    assert len(calls["search"]) == 1 and calls["official"] == 1
    assert "Nome que não deve ser pesquisado" not in calls["search"][0]
    assert second["reputation_indications"] == first["reputation_indications"]


def test_reputation_refresh_checks_more_than_three_domains_with_configured_budget(monkeypatch):
    from app import scraper_tools, search_provider
    calls = {"official": [], "search": []}
    class Reputation:
        def __init__(self, domain): self.domain = domain
        def model_dump(self, mode="json"):
            return {"supplier_domain": self.domain, "verified": False, "approved": False, "score": None,
                "checked_at": "2026-11-08T00:00:00+00:00", "status": "unrated", "reason": "Sem índice"}
    class Scraper:
        async def __aenter__(self): return self
        async def __aexit__(self, *args): pass
        async def reputation(self, offer):
            calls["official"].append(offer.supplier_domain)
            return Reputation(offer.supplier_domain)
    async def fake_wait(awaitable, timeout):
        return await awaitable
    async def fake_search(query):
        calls["search"].append(query)
        return []
    monkeypatch.setattr(scraper_tools, "MarketScraper", Scraper)
    monkeypatch.setattr(search_provider, "tavily_results", fake_search)
    monkeypatch.setattr(agent_service.asyncio, "wait_for", fake_wait)
    monkeypatch.setattr(agent_service.settings, "reputation_refresh_max_domains", 10)
    monkeypatch.setattr(agent_service.settings, "reputation_refresh_total_budget_seconds", 180)
    monkeypatch.setattr(agent_service.settings, "reputation_refresh_domain_timeout_seconds", 30)
    monkeypatch.setattr(agent_service, "require_internal_token", lambda token: None)
    agent_service._reputation_cache.clear()
    offers = [{"source_url": f"https://shop{i}.com.br/item"} for i in range(1, 6)]
    result = asyncio.run(agent_service.reputation_refresh(agent_service.ReputationRefreshRequest(offers=offers), None))
    assert len(result["reputations"]) == 5
    assert all(row["status"] == "unrated" for row in result["reputations"])
    assert len(calls["official"]) == len(calls["search"]) == 5


class DiscoveryMock:
    def __init__(self, products):
        self.products, self.errors, self.blocked_sites = products, [], 0


async def _async_result(value):
    return value


def test_conversation_turn_accepts_null_terms_on_greeting_or_clarification():
    from app.agent_intelligence import ConversationTurn
    turn = ConversationTurn.model_validate({
        "intent": "greeting",
        "reply": "Olá! Para concluir a cotação da TV Hisense, você pode informar taxas adicionais, prazo e estoque?",
        "terms": None,
        "explicit_confirmation": False,
        "terms_changed": False,
        "purchase_acceptance": "unclear",
    })
    assert turn.intent == "greeting"
    assert turn.terms.unit_cents is None


def test_conversation_turn_and_interpret_quote_return_bounded_timeout_diagnostic(monkeypatch):
    monkeypatch.setattr(agent_service, "require_internal_token", lambda token: None)
    monkeypatch.setattr(agent_service.settings, "gemini_api_key", "mock-key")
    monkeypatch.setattr(agent_service.settings, "llm_timeout_seconds", 0.05)
    class StalledGraph:
        async def ainvoke(self, state):
            await asyncio.sleep(1.0)
            return {"result": {}}
    monkeypatch.setattr(agent_service.app.state, "conversation_graph", StalledGraph(), raising=False)
    turn_req = agent_service.ConversationTurnRequest(
        product="Televisão Hisense 43 polegadas 4K", qty=1, destination="13565-090",
        message="A tv está custando 1875 com 67 de frete", phase="quotation", history=[],
    )
    turn_res = asyncio.run(agent_service.conversation_turn(turn_req, "valid-token"))
    assert turn_res["intent"] == "pending"
    assert turn_res["error_code"] == "TimeoutError"
    assert "TimeoutError" in turn_res["error_detail"]


def test_reputation_cache_uses_short_ttl_for_transient_failures_and_long_ttl_for_verified(monkeypatch):
    from app import scraper_tools, search_provider
    clock = [1000.0]
    calls = {"count": 0}
    monkeypatch.setattr(agent_service.time, "monotonic", lambda: clock[0])
    monkeypatch.setattr(agent_service, "require_internal_token", lambda token: None)
    async def empty_search(query):
        return []
    monkeypatch.setattr(search_provider, "tavily_results", empty_search)
    class Scraper:
        async def __aenter__(self): return self
        async def __aexit__(self, *args): pass
        async def reputation(self, offer):
            calls["count"] += 1
            if calls["count"] == 1:
                raise scraper_tools.ReputationError("HTTP 403", status="blocked")
            return scraper_tools.Reputation(
                supplier_domain=offer.supplier_domain, company_name="Loja",
                url="https://www.reclameaqui.com.br/empresa/loja/", score=Decimal("8.5"),
                scale=10, label="Ótimo", classification="Ótimo", period="Últimos 6 meses",
                source="reclameaqui.com.br", extraction_method="tavily_extract/basic", status="verified",
                checked_at="2026-01-01T00:00:00Z", verified=True, approved=True,
                reason="Reputação verificada ≥ 6,0.", evidence_sha256="c" * 64,
            )
    monkeypatch.setattr(scraper_tools, "MarketScraper", Scraper)
    agent_service._reputation_cache.clear()
    payload = agent_service.ReputationRefreshRequest(offers=[{"source_url": "https://loja.com.br/item"}])
    first = asyncio.run(agent_service.reputation_refresh(payload, None))
    assert first["reputations"][0]["verified"] is False
    assert first["reputations"][0]["status"] == "blocked"
    assert calls["count"] == 1
    # Advance past transient TTL (120s) but well before verified TTL (86400s)
    clock[0] += agent_service.REPUTATION_CACHE_TRANSIENT_TTL_SECONDS + 5
    second = asyncio.run(agent_service.reputation_refresh(payload, None))
    assert second["reputations"][0]["verified"] is True
    assert second["reputations"][0]["score"] == "8.5"
    assert calls["count"] == 2
    # Advance 3600s — verified entry must still be served from cache
    clock[0] += 3600
    third = asyncio.run(agent_service.reputation_refresh(payload, None))
    assert third["reputations"][0]["verified"] is True
    assert calls["count"] == 2


def test_parse_node_preserves_unknown_commercial_fields_as_null():
    state = {
        "task_id": "task-123",
        "destination": "13565-090",
        "raw_quotes": [{
            "event_id": "task-123:" + "d" * 64,
            "supplier": "Fast Shop",
            "unit_price": "1799.00",
            "shipping": None,
            "fees": None,
            "lead_days": None,
            "available_qty": None,
            "source_url": "https://www.fastshop.com.br/web/p/d/hisense-43",
            "product_confirmed": False,
            "destination_confirmed": False,
            "conditions": "Smart TV Hisense 43 4K | evidência " + "d" * 64,
        }],
        "reputations": [],
    }
    parsed = asyncio.run(agent_service.parse_node(state))["quotes"]
    assert len(parsed) == 1
    quote = parsed[0]
    assert quote["unit_cents"] == 179900
    assert quote["shipping_cents"] is None
    assert quote["fees_cents"] is None
    assert quote["lead_days"] is None
    assert quote["available_qty"] is None
    assert quote["destination_confirmed"] is False
