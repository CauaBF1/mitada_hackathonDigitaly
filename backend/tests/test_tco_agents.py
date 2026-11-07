import asyncio
import json
import time
from decimal import Decimal

import pytest
from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver
from langgraph.types import Command
from sqlalchemy import select

from app import agent
from app.database import SessionLocal, SupplierOutcome, ChatMessage, SupplierMemory
from app.orchestrator import read_dashboard, create_purchase, PurchaseInput
from app.scraper_tools import parse_product
from test_real_market import product, product_html
from test_telegram_agent import integrations, contact, wait_stage, webhook, parsed_offer


def shipping_html(value='0.00', **extra):
    return product_html(shippingDetails={'@type': 'OfferShippingDetails', 'shippingRate': {'@type': 'MonetaryAmount', 'currency': 'BRL', 'value': value}, 'shippingDestination': {'@type': 'DefinedRegion', 'addressCountry': 'BR'}, **extra})


def test_scraped_shipping_requires_unconditional_brazil_rate():
    row = parse_product(shipping_html(), 'https://store.com/m170', 'Mouse Logitech M170')
    assert row.shipping_fee == Decimal('0') and row.shipping_scope == 'BR'
    for extra in ({'eligibleTransactionVolume': {'minValue': 500}}, {'shippingDestination': {'addressCountry': 'BR', 'addressRegion': 'SP'}}, {'doesNotShip': True}):
        assert parse_product(shipping_html(**extra), row.product_url, row.product_name).shipping_fee is None
    assert product().shipping_fee is None


def test_tco_counts_quantity_and_shipping_once_and_never_assumes_zero():
    products = [product(i).model_copy(update={'shipping_fee': Decimal('10'), 'shipping_scope': 'BR'}) for i in range(3)]
    assert agent.market_budget(products, Decimal('100'), 1) == (Decimal('110'), Decimal('93.50'), Decimal('10'))
    assert agent.market_budget(products, Decimal('100'), 3) == (None, Decimal('255'), None)
    for p in products:
        p.shipping_fee = Decimal('0')
    assert agent.market_budget(products, Decimal('100'), 3) == (Decimal('300'), Decimal('255'), Decimal('0'))


def test_auditor_rejects_invented_shipping_and_buyer_only_evidence():
    history = [{'id': 1, 'sender': 'AI', 'text': 'Confirmo R$ 80,00, frete grátis, 1 unidade, 5 dias, Pix, sem taxas adicionais, CEP 01001-000'}, {'id': 2, 'sender': 'SUPPLIER', 'text': 'Confirmo R$ 80,00, 1 unidade, 5 dias, Pix, sem taxas adicionais, CEP 01001-000'}]
    offer = parsed_offer(history)
    grounded = agent.grounded_offer(offer, history)
    assert grounded.price == Decimal('80') and grounded.shipping_fee is None
    assert not agent.can_accept({'quantity': 1, 'target': '85'}, grounded)
    offer.evidence = [e.model_copy(update={'message_id': 1, 'quote': history[0]['text']}) for e in offer.evidence]
    assert agent.grounded_offer(offer, history).price is None


def test_unit_discount_with_high_freight_never_passes_budget():
    history = [{'id': 1, 'sender': 'SUPPLIER', 'text': 'Confirmo R$ 80,00 unitário, frete R$ 30,00, 2 unidades, 5 dias úteis, Pix, sem taxas adicionais, CEP 01001-000'}]
    offer = agent.grounded_offer(parsed_offer(history, shipping='30.00', qty=2), history)
    assert agent.offer_total(offer, 2) == Decimal('190')
    assert not agent.can_accept({'quantity': 2, 'target': '170'}, offer)
    assert offer.delivery_day_type == 'business'


def test_roberto_format_disallows_tags_json_and_long_monologues():
    for text in ('[SANDBOX] Oi', '{"text":"Oi"}', 'Solicitação #9: cotação', 'Oi. Tudo bem? Podemos negociar?', 'Oi\nTudo bem?', '<think>segredo</think>'):
        assert agent.conversational(text) is None
    assert agent.conversational('Olá, sou Roberto. Consegue R$ 85,00 com frete grátis?')


def test_graph_has_exactly_four_specialized_nodes(tmp_path):
    async def check():
        async with AsyncSqliteSaver.from_conn_string(str(tmp_path / 'shape.db')) as saver:
            graph = agent.build_graph(saver)
            assert set(graph.nodes) - {'__start__'} == {'discovery_node', 'memory_profiler_node', 'tactical_negotiator_node', 'compliance_auditor_node'}
    asyncio.run(check())


def test_quantity_negotiation_tco_metrics_and_memory(client, integrations, monkeypatch):
    contact()
    async def search(item, progress=None):
        from app.scraper_tools import Discovery, timestamp
        return Discovery(products=[product(i).model_copy(update={'shipping_fee': Decimal('0.00'), 'shipping_scope': 'BR'}) for i in range(3)], query=item, searched_at=timestamp())
    async def parse(model, history, memory):
        initial = '110,00' in history[-1]['text']
        return parsed_offer(history, '110.00' if initial else '80.00', shipping='20.00' if initial else '5.00', qty=2)
    monkeypatch.setattr(agent, 'search_market', search)
    monkeypatch.setattr(agent, 'interpret', parse)
    created = client.post('/request', json={'item': 'Mouse Logitech M170', 'qty': 2, 'delivery_location': 'CEP 01001-000, SP'})
    assert created.status_code == 201
    row = wait_stage(client, 'negotiating')
    assert row['tco_base'] == '200.00' and row['target_price'] == '170.00'
    webhook(client, 61, 'R$ 110,00 unitário, frete R$ 20,00, 2 unidades, 5 dias úteis, Pix, sem taxas adicionais, CEP 01001-000', 101)
    deadline = time.monotonic() + 8
    while len(integrations) < 2 and time.monotonic() < deadline:
        time.sleep(0.05)
    webhook(client, 62, 'Confirmo R$ 80,00 unitário, frete R$ 5,00, 2 unidades, 5 dias úteis, Pix, sem taxas adicionais, CEP 01001-000', 102)
    row = wait_stage(client, 'completed')
    assert row['quote']['initial_tco'] == '240.00'
    assert row['quote']['final_tco'] == '165.00'
    assert row['audit']['hard_savings'] == '60.00'
    assert row['audit']['shipping_savings'] == '15.00'
    assert row['audit']['tco_savings'] == '75.00'
    assert row['audit']['roi_basis'] == 'unit_price'
    assert row['audit']['cost_avoidance'] == '40.00'
    metrics = client.get('/dashboard/metrics').json()
    assert metrics['hard_savings'] == '60.00' and metrics['final_spend'] == '165.00'
    assert metrics['cost_avoidance'] == '40.00'
    with SessionLocal() as db:
        outcomes = list(db.scalars(select(SupplierOutcome)))
        assert len(outcomes) == 1
        assert json.loads(outcomes[0].summary)['discount_percentage'] == '27.27'
    assert agent.memory_for('store-0.com')['history_count'] == 1
    assert agent.memory_for('store-0.com', 'sandbox')['history_count'] == 0
    assert webhook(client, 63, 'Mudei de ideia', 102).json()['ignored']


def test_missing_initial_freight_never_creates_hard_savings(client):
    current = {'initial_tco': None}
    state = {'quantity': 2, 'target': '170', 'tco_base': None, 'mode': 'live'}
    history = [{'id': 1, 'sender': 'SUPPLIER', 'text': 'Confirmo R$ 80,00 unitário, 2 unidades, frete grátis, 5 dias, Pix, sem taxas adicionais, CEP 01001-000'}]
    offer = agent.grounded_offer(parsed_offer(history, qty=2), history)
    audit = agent.calculate_audit(state, current, offer, history)
    assert audit.final_tco == Decimal('160')
    assert audit.hard_savings is audit.cost_avoidance is None
    assert len(audit.limitations) >= 2


def test_old_paused_checkpoint_migrates_without_repeating_initial_message(client, integrations, tmp_path):
    from langgraph.graph import StateGraph, START, END
    from langgraph.types import interrupt
    from app.messaging import send_message
    from app.scraper_tools import timestamp
    contact()
    row = create_purchase(PurchaseInput(item='Mouse Logitech M170', qty=1), None)
    config = {'configurable': {'thread_id': 'old-checkpoint'}}
    current = {'round': 1, 'initial_price': '110.00', 'state': 'waiting', 'supplier': product().model_dump(mode='json'), 'memory': ''}
    async def run():
        await send_message(row.id, 'store-0.com', 'Cotação original', f'{row.id}:1:store-0.com:initial')
        async with AsyncSqliteSaver.from_conn_string(str(tmp_path / 'migration.db')) as saver:
            old = StateGraph(agent.AgentState)
            old.add_node('dispatch', lambda state: {})
            def wait_reply(state):
                return {'reply_id': interrupt('reply')}
            old.add_node('wait_reply', wait_reply)
            old.add_edge(START, 'dispatch')
            old.add_edge('dispatch', 'wait_reply')
            old.add_edge('wait_reply', END)
            await old.compile(checkpointer=saver).ainvoke({'request_id': row.id, 'generation': 1, 'item': row.item, 'model': 'test-model', 'average': '100.00', 'target': '85.00', 'negotiations': {'store-0.com': current}}, config)
            new = agent.build_graph(saver)
            snapshot = await agent.migrate_checkpoint(new, config, await new.aget_state(config), row)
            assert agent.is_interrupted(snapshot)
            assert snapshot.next == ('tactical_negotiator_node',)
            assert len(integrations) == 1
            with SessionLocal.begin() as db:
                reply = ChatMessage(request_id=row.id, supplier_domain='store-0.com', chat_id=123, sender_type='SUPPLIER', text='Confirmo R$ 80,00, 1 unidade, 5 dias, Pix, frete grátis, sem taxas adicionais, CEP 01001-000', timestamp=timestamp())
                db.add(reply)
                db.flush()
                identity = reply.id
            await new.ainvoke(Command(resume=identity), config)
            assert not (await new.aget_state(config)).next
    asyncio.run(run())
    assert len(integrations) == 2
    assert read_dashboard().runs[0].status == 'DONE'


def test_batna_requires_another_confirmed_comparable_quote():
    current = {'supplier': {'supplier_domain': 'one'}, 'last_offer': None}
    other = {'state': 'waiting', 'last_offer': agent.ParsedReply(additional_costs=[], price='90', shipping_fee='5', currency='BRL', available_qty=1, delivery_days=5, conditions='Pix', firm_offer=True, refused=False).model_dump(mode='json')}
    state = {'mode': 'live', 'quantity': 1, 'negotiations': {'one': current, 'two': other}}
    assert agent.batna_for(state, 'one')['total'] == '95.00'
    other['last_offer']['shipping_fee'] = None
    assert agent.batna_for(state, 'one') is None
    state['mode'] = 'sandbox'
    assert agent.batna_for(state, 'one') is None


def test_roberto_rejects_unsupported_amounts_and_premature_commitment():
    state = {'target': '170.00', 'average': '100.00', 'quantity': 2, 'mode': 'sandbox'}
    current = {'supplier': {'supplier_domain': 'test'}, 'last_offer': None}
    assert agent.valid_proposal('Consegue R$ 85,00 por unidade?', state, current, 'counter_offer')
    assert not agent.valid_proposal('Ofereço R$ 999,00.', state, current, 'counter_offer')
    assert not agent.valid_proposal('Fechado, aceito.', state, current, 'counter_offer')


def test_auditor_resumes_after_commit_without_reinterpreting_or_duplicating_memory(client, integrations, monkeypatch):
    from app.scraper_tools import timestamp
    contact()
    row = create_purchase(PurchaseInput(item='Mouse Logitech M170', qty=1), None)
    with SessionLocal.begin() as db:
        message = ChatMessage(request_id=row.id, supplier_domain='store-0.com', chat_id=123, sender_type='SUPPLIER', text='Confirmo R$ 80,00, 1 unidade, frete grátis, 5 dias, Pix, sem taxas adicionais, CEP 01001-000', timestamp=timestamp())
        db.add(message)
        db.flush()
        identity = message.id
    _, domain, history = agent.reply_context(identity)
    current = {'supplier': product().model_dump(mode='json'), 'initial_price': '110.00', 'initial_shipping_fee': '0.00', 'initial_tco': '110.00', 'memory': '', 'round': 1, 'state': 'waiting'}
    state = {'request_id': row.id, 'generation': 1, 'reply_id': identity, 'quantity': 1, 'target': '85.00', 'tco_base': None, 'mode': 'live', 'pending_audit': {'supplier_domain': domain}, 'negotiations': {domain: current}}
    offer = agent.grounded_offer(parsed_offer(history), history)
    agent.complete(state, current, offer, agent.calculate_audit(state, current, offer, history))
    async def unexpected(*args):
        raise AssertionError('A persisted completed audit must not invoke the model again')
    monkeypatch.setattr(agent, 'interpret', unexpected)
    asyncio.run(agent.compliance_auditor_node(state))
    asyncio.run(agent.compliance_auditor_node(state))
    assert len(integrations) == 1
    with SessionLocal() as db:
        assert len(list(db.scalars(select(SupplierOutcome)))) == 1
    assert read_dashboard().runs[0].status == 'DONE'
