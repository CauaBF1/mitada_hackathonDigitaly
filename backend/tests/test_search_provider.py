import asyncio
import json
import stat

import httpx
import pytest
from pydantic import SecretStr

from app import search_provider as provider
from app.config import settings


@pytest.fixture
def credentials(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, 'search_credentials_path', tmp_path / 'private' / 'search.json')
    monkeypatch.setattr(settings, 'tavily_api_key', None)
    monkeypatch.setattr(settings, 'brave_search_api_key', None)
    return settings.search_credentials_path


def usage(used=12, plan='Researcher', paygo=0):
    return {'key': {'usage': used, 'limit': 1000}, 'account': {'current_plan': plan, 'plan_usage': used, 'plan_limit': 1000, 'paygo_usage': 0, 'paygo_limit': paygo}}


def transport(monkeypatch, handler):
    client_class = httpx.AsyncClient
    monkeypatch.setattr(provider.httpx, 'AsyncClient', lambda **kwargs: client_class(transport=httpx.MockTransport(handler), **kwargs))


def test_unconfigured_status_never_contains_a_secret(client, credentials):
    result = client.get('/integrations/search').json()
    assert result['configured'] is False
    assert result['active_provider'] == 'public'
    assert 'api_key' not in result


def test_connect_validates_usage_before_saving_and_hides_key(client, credentials, monkeypatch):
    secret = 'tvly-test-credential-for-unit-tests'
    calls = []
    def handler(request):
        calls.append(str(request.url))
        assert request.headers['authorization'] == f'Bearer {secret}'
        return httpx.Response(200, json=usage())
    transport(monkeypatch, handler)
    headers = {'Origin': 'http://localhost:3000', 'X-Nexo-Settings': '1'}
    response = client.post('/integrations/search', json={'api_key': secret}, headers=headers)
    assert response.status_code == 200
    assert response.json()['verified'] is True
    assert response.json()['credits_remaining'] == 988
    assert secret not in response.text
    assert calls == ['https://api.tavily.com/usage']
    assert stat.S_IMODE(credentials.stat().st_mode) == 0o600
    assert provider.saved_key().get_secret_value() == secret
    assert secret not in client.get('/integrations/search').text


@pytest.mark.parametrize('status', [401, 429, 432, 500])
def test_invalid_key_and_provider_failures_do_not_save(client, credentials, monkeypatch, status):
    transport(monkeypatch, lambda request: httpx.Response(status, json={'detail': 'not returned directly'}))
    result = client.post('/integrations/search', json={'api_key': 'tvly-invalid-unit-test'}, headers={'Origin': 'http://localhost:3000', 'X-Nexo-Settings': '1'})
    assert result.status_code == 422
    assert not credentials.exists()
    assert 'tvly-invalid-unit-test' not in result.text


def test_cross_origin_cannot_change_configuration(client, credentials):
    result = client.post('/integrations/search', json={'api_key': 'tvly-valid-format-test'}, headers={'Origin': 'https://external.example', 'X-Nexo-Settings': '1'})
    assert result.status_code == 403
    assert not credentials.exists()


@pytest.mark.parametrize('plan,paygo,used', [('Project', 0, 0), ('Researcher', 10, 0), ('Researcher', 0, 1000)])
def test_paid_plans_paygo_and_exhausted_credits_never_trigger_search(credentials, monkeypatch, plan, paygo, used):
    provider.save_key(SecretStr('tvly-budget-test-credential'))
    calls = []
    def handler(request):
        calls.append(request.method)
        return httpx.Response(200, json=usage(used=used, plan=plan, paygo=paygo))
    transport(monkeypatch, handler)
    with pytest.raises(provider.SearchProviderError):
        asyncio.run(provider.tavily_search('Product query'))
    assert calls == ['GET']


def test_search_uses_basic_depth_no_generated_answer_and_real_response_urls(credentials, monkeypatch):
    provider.save_key(SecretStr('tvly-search-test-credential'))
    def handler(request):
        if request.method == 'GET':
            return httpx.Response(200, json=usage())
        body = json.loads(request.content)
        assert body['query'] == 'Mouse model'
        assert body['country'] == 'brazil'
        assert body['search_depth'] == 'basic'
        assert body['auto_parameters'] is False
        assert body['include_answer'] is False
        assert body['include_raw_content'] is False
        return httpx.Response(200, json={'results': [{'url': 'https://vendor.example/product'}, {'url': 'https://vendor.example/product'}]})
    transport(monkeypatch, handler)
    assert asyncio.run(provider.tavily_search('Mouse model')) == ['https://vendor.example/product']


def test_free_account_accepts_null_limits_from_live_usage_response(client, credentials, monkeypatch):
    body = usage(used=0)
    body['key']['limit'] = None
    body['account']['paygo_limit'] = None
    transport(monkeypatch, lambda request: httpx.Response(200, json=body))
    result = client.post('/integrations/search', json={'api_key': 'tvly-null-limits-test'}, headers={'Origin': 'http://localhost:3000', 'X-Nexo-Settings': '1'})
    assert result.status_code == 200
    assert result.json()['active_provider'] == 'tavily'
    assert result.json()['credits_remaining'] == 1000
    assert credentials.exists()


def test_unknown_or_used_paygo_is_not_treated_as_free():
    body = usage()
    del body['account']['paygo_limit']
    with pytest.raises(ValueError):
        provider.Usage.model_validate(body)
    body['account']['paygo_limit'] = None
    body['account']['paygo_usage'] = 1
    assert provider.Usage.model_validate(body).free_plan is False


@pytest.mark.parametrize('failure,expected', [('timeout', 'prazo'), ('network', 'rede'), ('schema', 'formato')])
def test_usage_failure_messages_are_specific_and_do_not_leak_credentials(credentials, monkeypatch, failure, expected):
    def handler(request):
        if failure == 'timeout':
            raise httpx.ReadTimeout('sensitive provider detail', request=request)
        if failure == 'network':
            raise httpx.ConnectError('sensitive provider detail', request=request)
        return httpx.Response(200, json={'unexpected': 'sensitive provider detail'})
    transport(monkeypatch, handler)
    async def check():
        async with httpx.AsyncClient() as client:
            return await provider.get_usage(client, SecretStr('tvly-error-message-test'))
    with pytest.raises(provider.SearchProviderError) as error:
        asyncio.run(check())
    assert expected in str(error.value)
    assert 'sensitive' not in str(error.value)
    assert 'tvly-' not in str(error.value)


def test_transient_usage_error_preserves_only_historical_balance(client, credentials, monkeypatch):
    provider.save_key(SecretStr('tvly-history-credential-test'))
    failed = False
    calls = []
    def handler(request):
        calls.append(request.method)
        if failed:
            raise httpx.ReadTimeout('provider details must stay private', request=request)
        return httpx.Response(200, json=usage(used=15))
    transport(monkeypatch, handler)
    first = client.get('/integrations/search').json()
    assert first['connection_status'] == 'verified'
    failed = True
    second = client.get('/integrations/search').json()
    assert second['connection_status'] == 'temporary_failure'
    assert second['balance_is_historical'] is True
    assert second['credits_remaining'] == 985
    assert second['last_verified_at'] == first['last_verified_at']
    assert second['active_provider'] == 'paused'
    assert len(calls) == 3
