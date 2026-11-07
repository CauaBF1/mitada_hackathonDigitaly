import asyncio
from decimal import Decimal

import pytest
from pydantic import SecretStr
from sqlalchemy.exc import IntegrityError, OperationalError

from app import agent, main, messaging
from app.config import settings
from app.database import SessionLocal, TelegramUpdate
from app.scraper_tools import parse_product
from test_real_market import product_html
from test_telegram_agent import integrations, contact, wait_stage


def test_short_database_outage_does_not_kill_queue_worker(client, integrations, monkeypatch):
    original = agent.next_work
    failures = []
    def temporarily_unavailable():
        if not failures:
            failures.append(True)
            raise OperationalError('test outage', None, None)
        return original()
    monkeypatch.setattr(agent, 'next_work', temporarily_unavailable)
    contact()
    client.post('/request', json={'item': 'Mouse Logitech M170'})
    row = wait_stage(client, 'negotiating')
    assert failures and client.get('/health').json()['status'] == 'ok'
    trace = client.get(f"/request/{row['id']}/trace").json()
    assert trace[0]['node'] == 'discovery_node'
    assert trace[0]['status'] == 'completed'
    assert trace[0]['output']['target'] == '80.75'


def test_second_worker_cannot_own_same_checkpoint_file(client):
    from fastapi.testclient import TestClient
    with pytest.raises(RuntimeError, match='Já existe um worker'):
        with TestClient(main.app):
            pass
    assert client.get('/health').json()['status'] == 'ok'


def test_database_failure_while_recording_agent_error_is_retried(client, integrations, monkeypatch):
    original = agent.persist_update
    calls = []
    async def broken_search(*args, **kwargs): raise agent.MessagingError('Falha controlada de pesquisa')
    def persist(*args, **kwargs):
        if args[1] == 'failed' and not calls:
            calls.append(True)
            raise OperationalError('temporary write failure', None, None)
        return original(*args, **kwargs)
    monkeypatch.setattr(agent, 'search_market', broken_search)
    monkeypatch.setattr(agent, 'persist_update', persist)
    row = client.post('/request', json={'item': 'Mouse Logitech M170'}).json()
    assert wait_stage(client, 'failed')['notice'] == 'Falha controlada de pesquisa'
    assert calls and client.get('/health').json()['status'] == 'ok'
    trace = client.get(f"/request/{row['id']}/trace").json()
    assert trace[-1]['status'] == 'failed' and trace[-1]['error_type'] == 'MessagingError'
    assert not integrations


def test_integrity_failure_is_not_acknowledged_as_duplicate(client, monkeypatch):
    def broken_transaction(): raise IntegrityError('controlled FK failure', None, None)
    monkeypatch.setattr(messaging.SessionLocal, 'begin', broken_transaction)
    with pytest.raises(IntegrityError):
        messaging.receive(messaging.IncomingUpdate(update_id=99999))
    with SessionLocal() as db: assert db.get(TelegramUpdate, 99999) is None


def test_integration_diagnostics_and_webhook_configuration_are_protected(client, monkeypatch):
    monkeypatch.setattr(settings, 'telegram_bot_token', SecretStr('test-only'))
    monkeypatch.setattr(settings, 'groq_api_key', SecretStr('test-only'))
    calls = []
    async def api(method, payload):
        calls.append((method, payload))
        return {'url': 'https://gateway.example/webhook/telegram'} if method == 'getWebhookInfo' else True
    monkeypatch.setattr(main, 'telegram', api)
    info = client.get('/integrations/agent').json()
    assert info['groq_configured'] and info['telegram_configured'] and not info['sandbox_configured']
    assert 'test-only' not in str(info)
    url = 'https://gateway.example/webhook/telegram'
    assert client.post('/integrations/telegram/webhook', json={'url': url}).status_code == 403
    headers = {'Origin': 'http://localhost:3000', 'X-Nexo-Settings': '1'}
    for invalid in ['http://gateway.example/webhook/telegram', 'https://gateway.example/other', 'https://user:password@gateway.example/webhook/telegram']:
        assert client.post('/integrations/telegram/webhook', headers=headers, json={'url': invalid}).status_code == 422
    assert client.post('/integrations/telegram/webhook', headers=headers, json={'url': url}).status_code == 200
    assert calls[-1][1]['drop_pending_updates'] is False
    assert calls[-1][1]['secret_token'] == 'test-telegram-secret'
    async def unavailable(*args, **kwargs): raise messaging.MessagingError('Telegram indisponível')
    monkeypatch.setattr(main, 'telegram', unavailable)
    assert client.get('/integrations/agent').json()['webhook_error'] == 'Telegram indisponível'
    assert client.post('/integrations/telegram/webhook', headers=headers, json={'url': url}).status_code == 503


def test_page_title_cannot_masquerade_as_supplier_name():
    html = product_html().replace('content="Store A"', 'content="Mouse Logitech M170"')
    offer = parse_product(html, 'https://example.com/product', 'Mouse Logitech M170')
    assert offer.supplier_name == 'example.com'


def test_audit_rejects_unknown_additional_fees():
    offer = agent.ParsedReply(price='80', shipping_fee='0', additional_costs=None, currency='BRL', firm_offer=True, refused=False)
    with pytest.raises(ValueError):
        agent.calculate_audit({'quantity': 1, 'target': '85'}, {}, offer, [])


def test_real_scraper_entrypoints_keep_query_and_identity(monkeypatch):
    from app import tools
    class Scraper:
        async def __aenter__(self): return self
        async def __aexit__(self, *args): pass
        async def discover(self, item):
            assert self.on_progress == 'callback'
            return item
        async def reputation(self, supplier): return supplier.supplier_domain
    monkeypatch.setattr(tools, 'RealMarketScraper', Scraper)
    assert asyncio.run(tools.search_market('Produto específico', 'callback')) == 'Produto específico'
    supplier = parse_product(product_html(), 'https://example.com/product', 'Mouse Logitech M170')
    assert asyncio.run(tools.check_reputation('Store A', supplier)) == 'example.com'
    with pytest.raises(ValueError): asyncio.run(tools.check_reputation('Different', supplier))


def test_discovery_refines_a_broad_query_before_starting_negotiation(client, integrations, monkeypatch):
    from app.scraper_tools import Discovery, timestamp
    from test_real_market import product
    queries = []
    async def search(item, progress=None):
        queries.append(item)
        products = [product(0, '95')] if len(queries) == 1 else [product(0, '95'), product(1, '100'), product(2, '105')]
        result = Discovery(products=products, query=item, searched_at=timestamp())
        if progress: await progress(result)
        return result
    monkeypatch.setattr(agent, 'search_market', search)
    contact()
    client.post('/request', json={'item': 'Mouse Logitech'})
    row = wait_stage(client, 'negotiating')
    assert queries == ['Mouse Logitech', 'Mouse Logitech M170']
    assert row['item'] == 'Mouse Logitech' and len(row['sources']) == 3
    assert row['market_average'] == '100.00'


def test_reputation_network_failure_never_homologates_supplier(client, integrations, monkeypatch):
    async def timeout(*args, **kwargs): raise TimeoutError()
    monkeypatch.setattr(agent, 'check_reputation', timeout)
    client.post('/request', json={'item': 'Mouse Logitech M170'})
    row = wait_stage(client, 'blocked')
    assert all(not rating['approved'] and rating['score'] is None for rating in row['reputations'])
    assert not integrations


def test_exhausted_inbound_retry_keeps_same_generation_and_receipt(client, monkeypatch):
    from app.database import AgentJob, ChatMessage
    from app.orchestrator import PurchaseInput, create_purchase
    from app.scraper_tools import timestamp
    monkeypatch.setattr(agent, 'next_work', lambda: None)
    row = create_purchase(PurchaseInput(item='Mouse Logitech M170', qty=1), None)
    with SessionLocal.begin() as db:
        db.add(AgentJob(request_id=row.id, status='waiting', generation=2))
        msg = ChatMessage(request_id=row.id, supplier_domain='example.com', chat_id=123, sender_type='SUPPLIER', text='Cotação preservada', timestamp=timestamp())
        db.add(msg); db.flush()
        db.add(TelegramUpdate(id=9000, request_id=row.id, message_id=msg.id, attempts=3, processed=False, error='timeout'))
    assert client.post(f'/request/{row.id}/retry').status_code == 202
    with SessionLocal() as db:
        receipt = db.get(TelegramUpdate, 9000)
        assert receipt.attempts == 0 and receipt.error is None and not receipt.processed
        assert db.get(AgentJob, row.id).generation == 2
    assert client.post('/request/999/retry').status_code == 404
