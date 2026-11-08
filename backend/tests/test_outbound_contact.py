import asyncio
import json
from uuid import UUID

import httpx
import pytest
from fastapi import HTTPException
from pydantic import SecretStr

from app import agent_service, voice_config_and_webhook as voice


CALL_ID = UUID('00112233-4455-6677-8899-aabbccddeeff')


def transport(monkeypatch, handler):
    client = httpx.AsyncClient
    monkeypatch.setattr(httpx, 'AsyncClient', lambda **kwargs: client(transport=httpx.MockTransport(handler), **kwargs))


def test_outbound_call_preserves_nest_supplier_binding(monkeypatch):
    monkeypatch.setattr(voice.settings, 'vapi_api_key', SecretStr('test-vapi'))
    monkeypatch.setattr(voice.settings, 'vapi_assistant_id', 'assistant-test')
    monkeypatch.setattr(voice.settings, 'vapi_phone_number_id', 'phone-test')

    def provider(request):
        assert request.url.path == '/call'
        assert request.headers['authorization'] == 'Bearer test-vapi'
        body = json.loads(request.content)
        assert body['metadata'] == {'request_id': 'nest-request', 'supplier_id': 'teste-whatsapp'}
        assert body['customer']['number'] == '+5517991636725'
        return httpx.Response(201, json={'id': str(CALL_ID), 'status': 'queued'})

    transport(monkeypatch, provider)
    payload = voice.OutboundCallRequest(request_id='nest-request', supplier_id='teste-whatsapp',
        phone_number='+5517991636725', supplier_name='Teste', item='Mouse', target_price='0', qty=1)
    result = asyncio.run(voice.trigger_vapi_call(payload))
    assert result.call_id == str(CALL_ID)


def test_polling_requires_auth_and_returns_bound_call(monkeypatch):
    monkeypatch.setenv('INTERNAL_API_TOKEN', 'internal-test')
    monkeypatch.setattr(voice.settings, 'vapi_api_key', SecretStr('test-vapi'))

    def provider(request):
        assert request.url.path == f'/call/{CALL_ID}'
        return httpx.Response(200, json={'id': str(CALL_ID), 'status': 'ended',
            'endedReason': 'customer-did-not-answer',
            'metadata': {'request_id': 'nest-request', 'supplier_id': 'teste-whatsapp'}})

    transport(monkeypatch, provider)
    with pytest.raises(HTTPException) as error:
        asyncio.run(voice.outbound_call_status(CALL_ID, None))
    assert error.value.status_code == 401
    result = asyncio.run(voice.outbound_call_status(CALL_ID, 'Bearer internal-test'))
    assert result == {'call_id': str(CALL_ID), 'status': 'ended', 'ended_reason': 'customer-did-not-answer',
        'request_id': 'nest-request', 'supplier_id': 'teste-whatsapp'}


@pytest.mark.parametrize('status, delivered', [(200, True), (404, True), (410, True), (401, False), (500, False)])
def test_deleted_callback_does_not_block_research_queue(monkeypatch, status, delivered):
    monkeypatch.setenv('INTERNAL_API_TOKEN', 'internal-test')
    monkeypatch.setenv('NEST_API_URL', 'http://api:4000')
    transport(monkeypatch, lambda request: httpx.Response(status, json={}))
    assert asyncio.run(agent_service.deliver_callback({'task_id': 'deleted-task'}, {})) is delivered
