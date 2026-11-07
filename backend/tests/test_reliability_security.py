import asyncio
import json
from decimal import Decimal
from types import SimpleNamespace

import httpx
import pytest
from fastapi import HTTPException
from sqlalchemy import select

from app import agent, messaging
from app.config import settings
from app.database import AgentJob, ChatMessage, SessionLocal, TelegramUpdate
from app.orchestrator import PurchaseInput, create_purchase
from app.scraper_tools import ScrapingError, parse_reputation, timestamp, validate_public_url
from app.tools import PinnedAdapter
from app.web_policy import AccessPolicy
from test_real_market import product
from test_telegram_agent import integrations, contact, wait_stage, webhook


def test_local_api_rejects_remote_host_origin_and_large_body(client):
    assert client.get('/godmode/dashboard', headers={'Host': 'attacker.example'}).status_code == 403
    assert client.post('/request', json={'item': 'Mouse'}, headers={'Origin': 'https://attacker.example'}).status_code == 403
    assert client.post('/request', content='x' * 65537).status_code == 413
    assert client.get('/chat/999').status_code == 404
    assert client.get('/request/999/trace').status_code == 404
    assert client.get('/chat/1?after=-1').status_code == 422


def test_mutation_rate_is_bounded(client, monkeypatch):
    monkeypatch.setattr(settings, 'mutations_per_minute', 1)
    # Start a fresh middleware window without affecting other clients.
    scope = client.app.middleware_stack
    while not isinstance(scope, __import__('app.local_access', fromlist=['LocalAccess']).LocalAccess):
        scope = scope.app
    scope.windows.clear()
    assert client.post('/request', json={}).status_code == 422
    assert client.post('/request', json={}).status_code == 429


def test_missing_checkpoint_preserves_reply_and_does_not_restart_dispatch(client, integrations):
    contact()
    row = create_purchase(PurchaseInput(item='Mouse Logitech M170', qty=1), None)
    with SessionLocal.begin() as db:
        db.add(AgentJob(request_id=row.id, status='waiting'))
        db.add(ChatMessage(request_id=row.id, supplier_domain='store-0.com', chat_id=123, sender_type='AI', text='Cotação anterior', timestamp=timestamp(), delivery_status='sent', telegram_message_id=500, action_key=f'{row.id}:1:store-0.com:initial'))
    assert webhook(client, 801, 'Confirmo R$ 80 cada, frete grátis, 1 unidade, 5 dias, Pix, sem taxas adicionais', 500).status_code == 200
    failed = wait_stage(client, 'failed')
    assert 'Checkpoint ausente' in failed['notice']
    with SessionLocal() as db:
        assert db.get(AgentJob, row.id).status == 'error'
        assert db.get(TelegramUpdate, 801).processed is False
        assert db.get(TelegramUpdate, 801).message_id is not None
    assert integrations == []
    client.post('/request', json={'item': 'Mouse Logitech M170'})
    assert wait_stage(client, 'negotiating')['id'] != row.id


def test_out_of_order_and_unauthorized_messages_are_ignored(client, integrations):
    contact()
    client.post('/request', json={'item': 'Mouse Logitech M170'})
    row = wait_stage(client, 'negotiating')
    assert webhook(client, 901, 'Ainda verificando o estoque', 101).status_code == 200
    response = webhook(client, 900, 'Proposta antiga', 101).json()
    assert response['ignored'] and 'antiga' in response['reason']
    assert webhook(client, 902, 'Confirmo preço', 101, chat=9999).json()['ignored']
    assert len([m for m in client.get(f"/chat/{row['id']}").json() if m['sender_type'] == 'SUPPLIER']) == 1


def test_response_during_send_is_retryable_without_recording_a_receipt(client, integrations):
    contact()
    row = create_purchase(PurchaseInput(item='Mouse Logitech M170', qty=1), None)
    with SessionLocal.begin() as db:
        db.add(AgentJob(request_id=row.id, status='running'))
        db.add(ChatMessage(request_id=row.id, supplier_domain='store-0.com', chat_id=123, sender_type='AI', text='Solicitando termos', timestamp=timestamp(), delivery_status='sending', action_key=f'{row.id}:1:store-0.com:initial'))
    assert webhook(client, 903, 'Olá', 101).status_code == 503
    with SessionLocal() as db:
        assert db.get(TelegramUpdate, 903) is None


def test_creation_and_enqueue_are_one_transaction(client, monkeypatch):
    import app.orchestrator as flow
    original = flow.event
    def fail(*args, **kwargs):
        raise RuntimeError('injected transaction failure')
    monkeypatch.setattr(flow, 'event', fail)
    with pytest.raises(RuntimeError):
        create_purchase(PurchaseInput(item='Mouse Logitech M170', qty=1), 'atomic', True)
    with SessionLocal() as db:
        assert db.scalar(select(flow.MarketRun).where(flow.MarketRun.client_key == 'atomic')) is None
        assert list(db.scalars(select(AgentJob))) == []
    monkeypatch.setattr(flow, 'event', original)
    one = create_purchase(PurchaseInput(item='Mouse Logitech M170', qty=1), 'atomic', True)
    assert create_purchase(PurchaseInput(item='Mouse Logitech M170', qty=1), 'atomic', True).id == one.id


def test_dns_rebinding_and_proxy_environment_cannot_change_pinned_connection(monkeypatch):
    import requests
    adapter = PinnedAdapter('93.184.216.34', 'example.com')
    captured = {}
    monkeypatch.setattr(adapter.poolmanager, 'connection_from_host', lambda **kw: captured.update(kw) or SimpleNamespace())
    prepared = requests.Request('GET', 'https://example.com/product').prepare()
    adapter.get_connection_with_tls_context(prepared, True, proxies={'https': 'http://127.0.0.1:9000'})
    assert captured['host'] == '93.184.216.34'
    assert captured['pool_kwargs']['server_hostname'] == 'example.com'
    assert captured['pool_kwargs']['assert_hostname'] == 'example.com'
    with pytest.raises(ScrapingError):
        adapter.get_connection_with_tls_context(requests.Request('GET', 'https://other.com/').prepare(), True)


def test_robots_disallow_and_unknown_access_policy_fail_closed():
    async def run():
        AccessPolicy.cache.clear()
        async def blocked(url):
            return 200, {'content-type': 'text/plain'}, 'User-agent: *\nDisallow: /private\n', url
        policy = AccessPolicy(blocked)
        await policy.allow('https://example.com/products')
        with pytest.raises(ScrapingError):
            await policy.allow('https://example.com/private/item')
        async def unavailable(url):
            return 403, {}, '', url
        with pytest.raises(ScrapingError):
            await AccessPolicy(unavailable).allow('https://example.net/product')
        async def no_rules(url):
            return 404, {}, '', url
        await AccessPolicy(no_rules).allow('https://example.org/product')
    asyncio.run(run())


def test_stale_reputation_period_cannot_approve_supplier():
    html = '<h1>Store A</h1><a href="https://store-0.com">Site</a>Nota média nos últimos 6 meses: 8/10. Dados de 01/01/2020 até 30/06/2020'
    with pytest.raises(ScrapingError, match='desatualizado'):
        parse_reputation(html, 'https://www.reclameaqui.com.br/empresa/store/', product())


@pytest.mark.parametrize('body,status', [([],200), ({'ok':False},429), ({'ok':True,'result':{}},200), ({'ok':True,'result':{'message_id':True}},200)])
def test_telegram_malformed_response_never_counts_as_delivery(monkeypatch, body, status):
    from pydantic import SecretStr
    monkeypatch.setattr(settings, 'telegram_bot_token', SecretStr('test-only'))
    real = httpx.AsyncClient
    transport = httpx.MockTransport(lambda request: httpx.Response(status, json=body))
    monkeypatch.setattr(messaging.httpx, 'AsyncClient', lambda **kwargs: real(transport=transport, **kwargs))
    with pytest.raises(messaging.MessagingError):
        asyncio.run(messaging.telegram('sendMessage', {'chat_id':123,'text':'test'}))
