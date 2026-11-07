import asyncio
from decimal import Decimal

from app import agent
from app.agent_intelligence import AuditorResponse, DiscoveryPlan, NegotiatorResponse, TacticalSummary
from app import agent_intelligence
from app.orchestrator import PurchaseInput, create_purchase, normalize_roi
from app.scraper_tools import Reputation, timestamp
from test_real_market import product
from test_telegram_agent import integrations, contact, parsed_offer, wait_stage


def test_gemini_structured_provider_adapter_is_mocked(monkeypatch):
    from pydantic import SecretStr
    from app.config import settings
    created = {}
    class FakeGemini:
        def __init__(self, **kwargs):
            created.update(kwargs)
        def with_structured_output(self, schema, method):
            assert schema is agent_intelligence.MemoryProfile
            assert method == 'function_calling'
            return self
        async def ainvoke(self, messages):
            return {'has_previous_history': False, 'historical_discount_avg_pct': None,
                    'preferred_concession': None, 'tactical_briefing': 'Sem histórico confirmado.'}
    monkeypatch.setattr(settings, 'llm_provider', 'gemini')
    monkeypatch.setattr(settings, 'gemini_api_key', SecretStr('mock-key'))
    monkeypatch.setattr(agent_intelligence, 'ChatGoogleGenerativeAI', FakeGemini)
    result = asyncio.run(agent_intelligence.memory_intelligence('gemini-test-model', {'supplier_history': []}))
    assert result.has_previous_history is False
    assert created['model'] == 'gemini-test-model' and created['api_key'] == 'mock-key'


def test_reputation_filter_precedes_baseline_and_ignores_llm_price_override(client, integrations, monkeypatch):
    contact('store-1.com')
    async def reputation(name, supplier):
        good = supplier.supplier_domain != 'store-0.com'
        return Reputation(supplier_domain=supplier.supplier_domain, score=Decimal('8' if good else '4'), approved=good, verified=True, reason='Test evidence', checked_at=timestamp())
    async def invented_plan(model, data):
        assert data['validated_plan']['baseline_tco'] is None
        assert data['validated_plan']['target_tco'] == '85.00'
        return DiscoveryPlan(approved_suppliers=['invented.invalid'], market_avg_unit_price='1', baseline_tco='1', target_tco='99999', discovery_justification='Estratégia considera exclusivamente as ofertas homologadas e o frete ainda pendente de confirmação.')
    monkeypatch.setattr(agent, 'check_reputation', reputation)
    monkeypatch.setattr(agent, 'discovery_intelligence', invented_plan)
    client.post('/request', json={'item': 'Mouse Logitech M170'})
    row = wait_stage(client, 'negotiating')
    assert row['target_price'] == '85.00'
    assert row['market_average'] == '102.50'
    assert set(row['discovery_plan']['approved_suppliers']) == {'store-1.com', 'store-2.com'}
    assert 'store-0.com' not in row['supplier_profiles']
    assert 'raciocinio_tatico' not in integrations[0][1]['text']
    assert row['tactical_summary']['estrategia_aplicada'] == 'SOLICITAR_COTACAO'


def test_sandbox_also_rejects_known_bad_reputation(client, integrations, monkeypatch):
    monkeypatch.setenv('MY_TELEGRAM_CHAT_ID', '555123')
    async def bad(name, supplier):
        return Reputation(supplier_domain=supplier.supplier_domain, score=Decimal('5'), verified=True, approved=False, reason='Below threshold', checked_at=timestamp())
    monkeypatch.setattr(agent, 'check_reputation', bad)
    client.post('/request', json={'item': 'Mouse Logitech M170', 'mode': 'sandbox'})
    row = wait_stage(client, 'blocked')
    assert row['target_price'] is None
    assert 'reputação' in row['notice']
    assert not integrations


def test_tactical_numbers_are_derived_from_grounded_terms(monkeypatch):
    async def model(name, data):
        assert data['target_unit_price'] == '82.50'
        return NegotiatorResponse(raciocinio_tatico=TacticalSummary(tco_oferta_atual='1', distancia_meta_pct='-99', estrategia_aplicada='BATNA'), mensagem_telegram='Para as duas unidades, consegue R$ 82,50 cada mantendo o frete?')
    monkeypatch.setattr(agent, 'negotiator_intelligence', model)
    history = [{'id': 1, 'sender': 'SUPPLIER', 'text': 'Confirmo 2 unidades a R$ 100,00 cada, frete R$ 5,00, 5 dias úteis, Pix, sem taxas adicionais, CEP 01001-000'}]
    offer = agent.grounded_offer(parsed_offer(history, '100.00', '5.00', 2), history)
    state = {'model': 'test', 'target': '170.00', 'average': '100.00', 'quantity': 2, 'mode': 'sandbox'}
    current = {'supplier': product().model_dump(mode='json'), 'memory': '', 'round': 1, 'last_offer': offer.model_dump(mode='json')}
    result = asyncio.run(agent.compose_message(state, current, history, 'counter_offer'))
    assert result.raciocinio_tatico.tco_oferta_atual == Decimal('205.00')
    assert result.raciocinio_tatico.distancia_meta_pct == Decimal('20.59')
    assert result.raciocinio_tatico.estrategia_aplicada == 'DESCONTO_VOLUME'


def test_supplier_profile_uses_real_discount_and_shipping_history():
    result = agent.memory_statistics({'past_negotiations': [
        {'initial_price': '100', 'final_price': '90', 'initial_shipping_fee': '15', 'shipping_fee': '0', 'conditions': 'Pix'},
        {'initial_price': '100', 'final_price': '100', 'initial_shipping_fee': '10', 'shipping_fee': '0', 'conditions': 'Boleto'},
    ]})
    assert result['historical_discount_avg_pct'] == Decimal('5.00')
    assert result['preferred_concession'] == 'FRETE_GRATIS'
    assert agent.memory_statistics({}) == {'has_previous_history': False, 'historical_discount_avg_pct': None, 'preferred_concession': None}


def test_unit_savings_remain_known_when_initial_freight_is_unknown():
    history = [{'id': 1, 'sender': 'SUPPLIER', 'text': 'Confirmo R$ 80,00 cada, 2 unidades, frete grátis, 5 dias úteis, Pix, sem taxas adicionais, CEP 01001-000'}]
    offer = agent.grounded_offer(parsed_offer(history, qty=2), history)
    audit = agent.calculate_audit({'quantity': 2, 'average': '100', 'target': '170', 'tco_base': None}, {'initial_price': '110'}, offer, history)
    assert audit.hard_savings == Decimal('60')
    assert audit.cost_avoidance == Decimal('40')
    assert audit.tco_savings is None and audit.shipping_savings is None


def test_invented_audit_metrics_cannot_enter_executive_justification():
    history = [{'id': 1, 'sender': 'SUPPLIER', 'text': 'Confirmo R$ 80,00, 1 unidade, frete grátis, 5 dias úteis, Pix, sem taxas adicionais, CEP 01001-000'}]
    offer = agent.grounded_offer(parsed_offer(history), history)
    audit = agent.calculate_audit({'quantity': 1, 'average': '100', 'target': '85'}, {'initial_price': '110'}, offer, history)
    payload = {field: getattr(audit, field) for field in AuditorResponse.model_fields}
    payload.update(hard_savings='999', audit_justification='Economia de R$ 999 confirmada. Esta cotação atende ao orçamento de compra.')
    assert agent.validated_audit_justification(AuditorResponse(**payload), audit, '85') == audit.justification


def test_old_tco_audit_is_normalized_without_changing_final_amount(client):
    from app.orchestrator import SupplierQuote
    row = create_purchase(PurchaseInput(item='Mouse Logitech M170', qty=2), None)
    history = [{'id': 1, 'sender': 'SUPPLIER', 'text': 'Confirmo R$ 80,00 cada, 2 unidades, frete R$ 5,00, 5 dias úteis, Pix, sem taxas adicionais, CEP 01001-000'}]
    offer = agent.grounded_offer(parsed_offer(history, shipping='5', qty=2), history)
    row.market_average = Decimal('100')
    row.audit = agent.calculate_audit({'quantity': 2, 'average': '100', 'target': '170', 'tco_base': '200'}, {'initial_price': '110', 'initial_shipping_fee': '20', 'initial_tco': '240'}, offer, history)
    row.audit.roi_basis = 'tco_v1'
    row.audit.hard_savings, row.audit.cost_avoidance = Decimal('75'), Decimal('35')
    row.quote = SupplierQuote(request_id=row.id, event_id='migration-test', product_url=product().product_url, initial_price='110', final_price='80', shipping_fee='5', initial_shipping_fee='20', final_tco='165', available_qty=2, delivery_time='5 dias úteis', conditions='Pix')
    result = normalize_roi(row)
    assert result.audit.roi_basis == 'unit_price'
    assert result.hard_savings == Decimal('60') and result.cost_avoidance == Decimal('40')
    assert result.audit.tco_savings == Decimal('75') and result.audit.shipping_savings == Decimal('15')
    assert result.quote.final_tco == Decimal('165')
    assert normalize_roi(result) == result
