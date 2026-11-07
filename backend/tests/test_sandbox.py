import asyncio
import time

import pytest
from sqlalchemy import select

from app import agent, messaging
from app.database import SessionLocal, ChatMessage, SupplierMemory
from app.orchestrator import create_purchase, PurchaseInput
from app.scraper_tools import Discovery, Reputation, timestamp
from test_real_market import product
from test_telegram_agent import integrations, wait_stage, webhook, contact


@pytest.fixture
def personal(monkeypatch):
    monkeypatch.setenv('MY_TELEGRAM_CHAT_ID', '555123')


def test_sandbox_negotiates_with_personal_chat_and_never_changes_real_metrics_or_memory(client, integrations, personal, monkeypatch):
    contact()
    async def discovery(item, progress=None):
        return Discovery(products=[product(0, '100.00')], query=item, searched_at=timestamp())
    async def unavailable(name, supplier):
        return Reputation(supplier_domain=supplier.supplier_domain, checked_at=timestamp(), reason='Blocked by source')
    monkeypatch.setattr(agent, 'search_market', discovery)
    monkeypatch.setattr(agent, 'check_reputation', unavailable)
    created = client.post('/request', json={'item': 'Mouse Logitech M170', 'mode': 'sandbox'}, headers={'Idempotency-Key': 'demo-only'})
    assert created.status_code == 201
    row = wait_stage(client, 'negotiating')
    assert row['mode'] == 'sandbox'
    assert row['target_price'] == '85.00'
    assert row['reputations'][0]['approved'] is False
    assert integrations[0][1]['chat_id'] == 555123
    assert '[SANDBOX' not in integrations[0][1]['text']
    assert 'Roberto' in integrations[0][1]['text']
    assert webhook(client, 40, '110 BRL', 101, chat=123).json()['ignored']
    assert webhook(client, 41, 'R$ 110,00, 1 unidade, 5 dias, Pix, frete grátis, sem taxas adicionais, CEP 01001-000', 101, chat=555123).status_code == 200
    deadline = time.monotonic() + 8
    while len(integrations) < 2 and time.monotonic() < deadline:
        time.sleep(0.05)
    assert len(integrations) == 2
    assert integrations[1][1]['chat_id'] == 555123
    assert webhook(client, 41, 'R$ 110,00', 101, chat=555123).json()['duplicate']
    assert webhook(client, 42, 'Confirmo R$ 80,00, 1 unidade, 5 dias, Pix, frete grátis, sem taxas adicionais, CEP 01001-000', 102, chat=555123).status_code == 200
    final = wait_stage(client, 'completed')
    assert final['hard_savings'] == '30.00'
    assert final['cost_avoidance'] == '20.00'
    assert final['status'] == 'DONE'
    metrics = client.get('/dashboard/metrics').json()
    assert metrics['hard_savings'] == metrics['cost_avoidance'] == metrics['final_spend'] == '0.00'
    assert metrics['completed_count'] == metrics['verified_suppliers_count'] == 0
    history = client.get(f"/chat/{row['id']}").json()
    assert [m['sender_type'] for m in history] == ['AI', 'SUPPLIER', 'AI', 'SUPPLIER', 'AI']
    with SessionLocal() as db:
        assert db.get(SupplierMemory, 'store-0.com').chat_id == 123
        assert db.get(SupplierMemory, 'store-0.com').summary == 'Compra anterior: prazo de 5 dias.'
        assert all(m.chat_id == 555123 for m in db.scalars(select(ChatMessage)))


@pytest.mark.parametrize('chat_id', ['', 'not-a-number', '-123', '0', str(2**52)])
def test_invalid_sandbox_destination_rejects_creation_without_live_fallback(client, integrations, monkeypatch, chat_id):
    monkeypatch.setenv('MY_TELEGRAM_CHAT_ID', chat_id)
    result = client.post('/request', json={'item': 'Mouse Logitech M170', 'mode': 'sandbox'})
    assert result.status_code == 422
    assert client.get('/godmode/dashboard').json()['runs'] == []
    assert not integrations


def test_client_cannot_override_personal_destination_or_reuse_idempotency_for_live(client, integrations, personal):
    payload = {'item': 'Mouse Logitech M170', 'mode': 'sandbox'}
    assert client.post('/request', json={**payload, 'chat_id': 999}).status_code == 422
    created = client.post('/request', json=payload, headers={'Idempotency-Key': 'isolated'})
    assert created.status_code == 201
    assert client.post('/request', json={**payload, 'mode': 'live'}, headers={'Idempotency-Key': 'isolated'}).status_code == 409
    wait_stage(client, 'negotiating')


def test_personal_chat_change_does_not_reroute_an_existing_conversation(client, integrations, personal, monkeypatch):
    row = create_purchase(PurchaseInput(item='Mouse Logitech M170', qty=1, mode='sandbox'), None)
    asyncio.run(messaging.send_telegram_message(row.id, 'store-0.com', 'Pedido', 'first'))
    monkeypatch.setenv('MY_TELEGRAM_CHAT_ID', '666123')
    with pytest.raises(messaging.MessagingError, match='alterado'):
        asyncio.run(messaging.send_telegram_message(row.id, 'store-0.com', 'Contraoferta', 'second'))
    assert len(integrations) == 1
    assert webhook(client, 44, 'R$ 80,00', 101, chat=555123).json()['ignored']


def test_plain_personal_reply_requires_one_unambiguous_active_demo(client, integrations, personal):
    client.post('/request', json={'item': 'Mouse Logitech M170', 'mode': 'sandbox'})
    first = wait_stage(client, 'negotiating')
    payload = {'update_id': 80, 'message': {'message_id': 1800, 'chat': {'id': 555123, 'type': 'private'}, 'text': 'R$ 110,00, entrega em 5 dias, Pix, frete grátis, sem taxas adicionais, CEP 01001-000'}}
    headers = {'X-Telegram-Bot-Api-Secret-Token': 'test-telegram-secret'}
    assert client.post('/webhook/telegram', json=payload, headers=headers).json() == {'ok': True}
    client.post('/request', json={'item': 'Mouse Logitech M170', 'mode': 'sandbox'})
    wait_stage(client, 'negotiating')
    result = client.post('/webhook/telegram', json={**payload, 'update_id': 81, 'message': {**payload['message'], 'message_id': 1801}}, headers=headers)
    assert result.json()['ignored']
    assert 'Use Responder' in integrations[-1][1]['text']
    assert len([m for m in client.get(f"/chat/{first['id']}").json() if m['sender_type'] == 'SUPPLIER']) == 1
