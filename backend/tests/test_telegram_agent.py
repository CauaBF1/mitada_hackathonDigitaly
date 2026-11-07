import asyncio
import time
from decimal import Decimal

import pytest
from pydantic import SecretStr
from sqlalchemy import select
from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver
from langgraph.types import Command

from app import agent, messaging
from app.agent_intelligence import DiscoveryPlan, MemoryProfile, NegotiatorResponse, TacticalSummary, AuditorResponse
from app.config import settings
from app.database import SessionLocal, SupplierMemory, ChatMessage, TelegramUpdate
from app.orchestrator import create_purchase, PurchaseInput, read_dashboard
from app.scraper_tools import Discovery, Reputation, timestamp
from app.tools import comparable_market
from test_real_market import product


@pytest.fixture
def integrations(monkeypatch):
    monkeypatch.setattr(settings, 'groq_api_key', SecretStr('groq-test-only'))
    monkeypatch.setattr(settings, 'telegram_bot_token', SecretStr('telegram-test-only'))
    calls = []
    async def search(item, progress=None):
        return Discovery(products=[product(0, '95.00'), product(1, '100.00'), product(2, '105.00')], query=item, searched_at=timestamp())
    async def reputation(name, supplier):
        return Reputation(supplier_domain=supplier.supplier_domain, score=Decimal('8'), approved=True, verified=True, reason='Fixture', checked_at=timestamp())
    async def resolve():
        return 'test-model'
    async def send(method, payload):
        calls.append((method, payload))
        return {'message_id': 100 + len(calls), 'username': 'fixture_bot'}
    async def interpret(model, history, memory):
        price = '80.00' if '80' in history[-1]['text'] else '110.00'
        return parsed_offer(history, price)
    async def discovery(model, data):
        plan = DiscoveryPlan.model_validate(data['validated_plan'])
        plan.discovery_justification = 'Estratégia baseada nas ofertas reais verificadas e no menor preço elegível, respeitando as limitações de frete.'
        return plan
    async def memory(model, data):
        return MemoryProfile(**data['validated_statistics'], tactical_briefing='- Condições anteriores registradas.\n- Confirmar novos valores e entrega com o fornecedor.')
    async def compose(model, data):
        text = 'Olá, sou o Roberto, comprador da Nexo. Pode confirmar preço, frete e prazo?' if data['phase'] == 'initial' else f"Consegue R$ {data['target_total']} no total, com frete grátis ou desconto no PIX?"
        return NegotiatorResponse(raciocinio_tatico=TacticalSummary(**data['validated_tactical_summary'], estrategia_aplicada='PAGAMENTO_PIX'), mensagem_telegram=text)
    async def audit(model, data):
        values = data['validated_audit']
        return AuditorResponse(**{key: values[key] for key in AuditorResponse.model_fields})
    monkeypatch.setattr(agent, 'discovery_intelligence', discovery)
    monkeypatch.setattr(agent, 'memory_intelligence', memory)
    monkeypatch.setattr(agent, 'negotiator_intelligence', compose)
    monkeypatch.setattr(agent, 'auditor_intelligence', audit)
    monkeypatch.setattr(agent, 'search_market', search)
    monkeypatch.setattr(agent, 'check_reputation', reputation)
    monkeypatch.setattr(agent, 'resolve_model', resolve)
    monkeypatch.setattr(agent, 'interpret', interpret)
    monkeypatch.setattr(messaging, 'telegram', send)
    return calls


def parsed_offer(history, price='80.00', shipping='0.00', qty=1, days=5):
    msg = history[-1]
    fields = ('price', 'shipping_fee', 'available_qty', 'delivery_days', 'conditions', 'currency', 'additional_costs', 'acceptance', 'delivery_location')
    return agent.ParsedReply(additional_costs=[], agreement_confirmed=True, delivery_location='CEP 01001-000', price=price, shipping_fee=shipping, currency='BRL', available_qty=qty, delivery_days=days, conditions='Pix', firm_offer=True, refused=False, evidence=[agent.TermEvidence(field=f, message_id=msg['id'], quote=msg['text']) for f in fields])


def contact(domain='store-0.com', chat=123):
    with SessionLocal.begin() as db:
        db.add(SupplierMemory(domain=domain, name='Store', chat_id=chat, authorized_at=timestamp(), summary='Compra anterior: prazo de 5 dias.'))


def wait_stage(client, stage):
    deadline = time.monotonic() + 8
    while time.monotonic() < deadline:
        row = client.get('/godmode/dashboard').json()['runs'][0]
        if row['stage'] == stage:
            return row
        time.sleep(0.05)
    raise AssertionError(row)


def webhook(client, update_id, text, reply, chat=123):
    return client.post('/webhook/telegram', json={'update_id': update_id, 'message': {'message_id': update_id + 1000, 'chat': {'id': chat, 'type': 'private'}, 'text': text, 'reply_to_message': {'message_id': reply}}}, headers={'X-Telegram-Bot-Api-Secret-Token': 'test-telegram-secret'})


def test_real_contract_discovery_dispatch_counteroffer_and_completion(client, integrations):
    contact()
    created = client.post('/request', json={'item': 'Mouse Logitech M170'}, headers={'Idempotency-Key': 'purchase'})
    assert created.status_code == 201
    assert client.post('/request', json={'item': 'Mouse Logitech M170'}, headers={'Idempotency-Key': 'purchase'}).json()['id'] == created.json()['id']
    row = wait_stage(client, 'negotiating')
    assert row['target_price'] == '80.75'
    assert row['market_average'] == '100.00'
    assert len(integrations) == 1
    history = client.get(f"/chat/{row['id']}").json()
    assert history[0]['delivery_status'] == 'sent'
    assert 'chat_id' not in history[0]
    assert client.post('/webhook/telegram', json={'update_id': 10}).status_code == 401
    assert webhook(client, 1, 'R$ 110,00, 1 unidade, 5 dias, Pix, frete grátis, sem taxas adicionais, CEP 01001-000', 101, chat=999).json()['ignored']
    assert webhook(client, 2, 'R$ 110,00, 1 unidade, 5 dias, Pix, frete grátis, sem taxas adicionais, CEP 01001-000', 101).status_code == 200
    deadline = time.monotonic() + 8
    while len(integrations) < 2 and time.monotonic() < deadline:
        time.sleep(0.05)
    assert len(integrations) == 2
    assert webhook(client, 2, 'R$ 110,00', 101).json()['duplicate']
    assert webhook(client, 3, 'Confirmo R$ 80,00, 1 unidade, 5 dias, Pix, frete grátis, sem taxas adicionais, CEP 01001-000', 102).status_code == 200
    finished = wait_stage(client, 'completed')
    assert finished['status'] == 'DONE'
    assert finished['hard_savings'] == '30.00'
    assert finished['cost_avoidance'] == '20.00'
    assert finished['quote']['final_tco'] == '80.00'
    assert finished['audit']['shipping_fee'] == '0.00'
    assert len(client.get(f"/chat/{row['id']}").json()) == 5
    with SessionLocal() as db:
        assert '80.00' in db.get(SupplierMemory, 'store-0.com').summary
    assert client.post(f"/request/{row['id']}/retry").status_code == 409


def test_no_contact_never_sends_to_arbitrary_discovered_supplier(client, integrations):
    client.post('/request', json={'item': 'Mouse Logitech M170'})
    row = wait_stage(client, 'blocked')
    assert not integrations
    assert row['quote'] is None


def test_bad_reputation_is_never_dispatched(client, integrations, monkeypatch):
    contact()
    async def bad(name, supplier):
        return Reputation(supplier_domain=supplier.supplier_domain, score=Decimal('5'), approved=False, verified=True, reason='Below threshold', checked_at=timestamp())
    monkeypatch.setattr(agent, 'check_reputation', bad)
    client.post('/request', json={'item': 'Mouse Logitech M170'})
    wait_stage(client, 'blocked')
    assert integrations == []


def test_distinct_models_and_variants_do_not_create_a_market_average():
    products = [product(i).model_copy(update={'product_name': f'Notebook Model {i} 8GB'}) for i in range(3)]
    selected, average, target = comparable_market(products)
    assert len(selected) == 1
    assert average is target is None


def test_supplier_invite_binds_private_chat_once(client, integrations):
    assert client.post('/suppliers/invite', json={'name': 'Store', 'domain': 'store-0.com'}).status_code == 403
    result = client.post('/suppliers/invite', json={'name': 'Store', 'domain': 'store-0.com'}, headers={'Origin': 'http://localhost:3000', 'X-Nexo-Settings': '1'})
    token = result.json()['url'].split('start=')[1]
    assert webhook(client, 30, '/start ' + token, 1).status_code == 200
    assert webhook(client, 31, '/start ' + token, 1, chat=999).status_code == 200
    with SessionLocal() as db:
        row = db.get(SupplierMemory, 'store-0.com')
        assert row.chat_id == 123 and row.invite_hash is None
    assert client.get('/suppliers/contacts').json()[0]['authorized']


def test_checkpoint_reopens_without_repeating_dispatch(client, integrations, tmp_path):
    contact()
    row = create_purchase(PurchaseInput(item='Mouse Logitech M170', qty=1), None)
    config = {'configurable': {'thread_id': 'restart-test'}}
    async def run():
        async with AsyncSqliteSaver.from_conn_string(str(tmp_path / 'resume.db')) as saver:
            graph = agent.build_graph(saver)
            await graph.ainvoke({'request_id': row.id, 'generation': 1, 'item': row.item}, config)
            assert (await graph.aget_state(config)).next == ('tactical_negotiator_node',)
        with SessionLocal.begin() as db:
            msg = ChatMessage(request_id=row.id, supplier_domain='store-0.com', chat_id=123, sender_type='supplier', text='Confirmo R$ 80,00, 1 unidade, 5 dias, Pix, frete grátis, sem taxas adicionais, CEP 01001-000', timestamp=timestamp())
            db.add(msg)
            db.flush()
            message_id = msg.id
        async with AsyncSqliteSaver.from_conn_string(str(tmp_path / 'resume.db')) as saver:
            graph = agent.build_graph(saver)
            await graph.ainvoke(Command(resume=message_id), config)
            assert not (await graph.aget_state(config)).next
    asyncio.run(run())
    assert len(integrations) == 2
    assert read_dashboard().runs[0].status == 'DONE'


def test_uncertain_send_is_not_retried(client, integrations, monkeypatch):
    contact()
    row = create_purchase(PurchaseInput(item='Mouse Logitech M170', qty=1), None)
    calls = []
    async def timeout(method, payload):
        calls.append(1)
        raise messaging.MessagingError('Timeout')
    monkeypatch.setattr(messaging, 'telegram', timeout)
    for _ in range(2):
        with pytest.raises(messaging.MessagingError):
            asyncio.run(messaging.send_message(row.id, 'store-0.com', 'Pedido de cotação', 'same-action'))
    assert len(calls) == 1


def test_retry_preserves_quantity_for_new_tco_flow(client):
    row = create_purchase(PurchaseInput(item='Mouse Logitech M170', qty=3), None)
    result = client.post(f'/request/{row.id}/retry')
    assert result.status_code == 202
    assert read_dashboard().runs[0].qty == 3
