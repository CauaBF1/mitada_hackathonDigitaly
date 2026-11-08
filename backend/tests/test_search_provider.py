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
    async def inline_threadpool(func, *args):
        return func(*args)
    monkeypatch.setattr(provider, 'run_in_threadpool', inline_threadpool)
    return settings.search_credentials_path


@pytest.fixture(autouse=True)
def clear_provider_caches():
    provider.verified_usage.clear()
    provider.usage_cache.clear()
    provider.usage_reservations.clear()
    provider.search_cooldowns.clear()
    provider.extract_cooldowns.clear()
    provider.usage_cooldowns.clear()


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
    async def check():
        async with httpx.AsyncClient() as client:
            await provider.get_usage(client, SecretStr('tvly-budget-test-credential'))
        with pytest.raises(provider.SearchProviderError):
            await provider.tavily_search('Product query')
    asyncio.run(check())
    assert calls == ['GET']


def test_search_uses_basic_depth_no_generated_answer_and_real_response_urls(credentials, monkeypatch):
    provider.save_key(SecretStr('tvly-search-test-credential'))
    calls = []
    def handler(request):
        calls.append(request.url.path)
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
    assert calls == ['/search']


def test_cold_usage_429_does_not_gate_search(credentials, monkeypatch):
    provider.save_key(SecretStr('tvly-cold-usage-rate-limit-test'))
    calls = []
    def handler(request):
        calls.append(request.url.path)
        if request.url.path.endswith('/usage'):
            return httpx.Response(429, headers={'Retry-After': '60'}, json={'detail': 'excessive requests'})
        return httpx.Response(200, json={'results': [{'url': 'https://vendor.example/product'}]})
    transport(monkeypatch, handler)
    assert asyncio.run(provider.tavily_search('query with cold usage cache')) == ['https://vendor.example/product']
    assert calls == ['/search']


def test_search_retries_once_after_short_429_then_returns_results(credentials, monkeypatch):
    provider.save_key(SecretStr('tvly-search-retry-test'))
    calls = []
    def handler(request):
        calls.append(request.method)
        if request.method == 'GET':
            return httpx.Response(200, json=usage())
        if len([method for method in calls if method == 'POST']) == 1:
            return httpx.Response(429, headers={'Retry-After': '0'}, json={'detail': 'too many requests'})
        return httpx.Response(200, json={'results': [{'url': 'https://vendor.example/recovered'}]})
    transport(monkeypatch, handler)
    assert asyncio.run(provider.tavily_search('Samsung Galaxy S25 Ultra')) == ['https://vendor.example/recovered']
    assert calls == ['POST', 'POST']


def test_search_cooldown_prevents_repeated_network_calls(credentials, monkeypatch):
    provider.save_key(SecretStr('tvly-search-cooldown-test'))
    calls = []
    def handler(request):
        calls.append(request.method)
        if request.method == 'GET':
            return httpx.Response(200, json=usage())
        return httpx.Response(429, headers={'Retry-After': '60'}, json={'detail': 'excessive requests'})
    transport(monkeypatch, handler)
    with pytest.raises(provider.SearchProviderError) as first:
        asyncio.run(provider.tavily_search('first query'))
    assert first.value.code == 'rate_limit'
    with pytest.raises(provider.SearchProviderError) as second:
        asyncio.run(provider.tavily_search('second query'))
    assert second.value.code == 'rate_limit'
    assert calls == ['POST']


def test_usage_cache_is_key_specific_and_reserves_estimated_credits(credentials, monkeypatch):
    calls = []
    def handler(request):
        calls.append(request.headers['authorization'])
        return httpx.Response(200, json=usage())
    transport(monkeypatch, handler)
    key_a = SecretStr('tvly-cache-key-a')
    key_b = SecretStr('tvly-cache-key-b')
    async def check():
        async with httpx.AsyncClient() as client:
            first = await provider.get_usage(client, key_a)
            provider._reserve_credits(key_a, 1)
            cached = await provider.get_usage(client, key_a)
            other_key = await provider.get_usage(client, key_b)
            return first.remaining, cached.remaining, other_key.remaining
    assert asyncio.run(check()) == (988, 987, 988)
    assert calls == ['Bearer tvly-cache-key-a', 'Bearer tvly-cache-key-b']


def test_usage_429_cooldown_does_not_block_search_with_valid_cached_budget(credentials, monkeypatch):
    provider.save_key(SecretStr('tvly-usage-cooldown-search-test'))
    calls = []
    def handler(request):
        calls.append(request.method)
        if request.method == 'GET' and calls.count('GET') == 1:
            return httpx.Response(200, json=usage())
        if request.method == 'GET':
            return httpx.Response(429, headers={'Retry-After': '60'}, json={'detail': 'excessive requests'})
        if request.url.path.endswith('/extract'):
            return httpx.Response(200, json={'results': [{'url': 'https://vendor.example/product', 'raw_content': 'product content'}], 'failed_results': []})
        return httpx.Response(200, json={'results': [{'url': 'https://vendor.example/product'}]})
    transport(monkeypatch, handler)
    async def allow_url(url):
        return url
    async def check():
        key = provider.saved_key()
        async with httpx.AsyncClient() as client:
            await provider.get_usage(client, key)
            with pytest.raises(provider.SearchProviderError) as exc:
                await provider.get_usage(client, key, force=True)
            assert exc.value.code == 'rate_limit'
        rows = await provider.tavily_search('query after usage rate limit')
        extracted = await provider.tavily_extract(['https://vendor.example/product'], validate_url=allow_url)
        return rows, extracted
    rows, extracted = asyncio.run(check())
    assert rows == ['https://vendor.example/product']
    assert extracted.results == {'https://vendor.example/product': 'product content'}
    assert calls == ['GET', 'GET', 'POST', 'POST']


def test_429_with_credit_quota_detail_preserves_credit_error(credentials, monkeypatch):
    provider.save_key(SecretStr('tvly-429-credit-detail-test'))
    def handler(request):
        if request.method == 'GET':
            return httpx.Response(200, json=usage())
        return httpx.Response(429, json={'detail': 'insufficient credits for this request'})
    transport(monkeypatch, handler)
    with pytest.raises(provider.SearchProviderError) as exc:
        asyncio.run(provider.tavily_search('query'))
    assert exc.value.code == 'insufficient_credits'


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


def test_tavily_extract_validates_budget_and_extracts_markdown_content(credentials, monkeypatch):
    provider.save_key(SecretStr('tvly-extract-test-credential'))
    calls = []
    def handler(request):
        calls.append((request.method, str(request.url)))
        if request.method == 'GET':
            return httpx.Response(200, json=usage(used=10))
        body = json.loads(request.content)
        assert body['urls'] == ['https://vendor.example/product-1']
        assert body['extract_depth'] == 'basic'
        assert body['format'] == 'markdown'
        return httpx.Response(200, json={
            'results': [{'url': 'https://vendor.example/product-1', 'raw_content': '# Smart TV Hisense 43" 4K\nPreço à vista R$ 1.799,00'}],
            'failed_results': [],
        })
    transport(monkeypatch, handler)
    async def allow_url(url):
        return url
    extracted = asyncio.run(provider.tavily_extract(['https://vendor.example/product-1'], query='Smart TV Hisense 43', validate_url=allow_url))
    assert calls == [('POST', 'https://api.tavily.com/extract')]
    assert 'https://vendor.example/product-1' in extracted.results
    assert '1.799,00' in extracted.results['https://vendor.example/product-1']


@pytest.mark.parametrize('scenario,expected_code', [
    ('rate_limit', 'rate_limit'),
    ('insufficient_credits', 'insufficient_credits'),
    ('budget_zero', 'insufficient_credits'),
    ('server_error', 'unavailable'),
])
def test_tavily_extract_separates_rate_limit_credits_and_unavailability(credentials, monkeypatch, scenario, expected_code):
    provider.save_key(SecretStr('tvly-extract-error-credential'))
    def handler(request):
        if request.method == 'GET':
            used = 1000 if scenario == 'budget_zero' else 10
            return httpx.Response(200, json=usage(used=used))
        if scenario == 'budget_zero':
            return httpx.Response(432, json={'detail': 'quota exceeded'})
        if scenario == 'rate_limit':
            return httpx.Response(429, json={'detail': 'rate limit exceeded'})
        if scenario == 'insufficient_credits':
            return httpx.Response(432, json={'detail': 'quota exceeded'})
        return httpx.Response(503, json={'detail': 'service unavailable'})
    transport(monkeypatch, handler)
    async def allow_url(url):
        return url
    with pytest.raises(provider.SearchProviderError) as exc_info:
        asyncio.run(provider.tavily_extract(['https://vendor.example/product-1'], validate_url=allow_url))
    assert exc_info.value.code == expected_code
    assert 'tvly-' not in str(exc_info.value)


def test_tavily_extract_ignores_empty_or_failed_results_and_blocks_ssrf(credentials, monkeypatch):
    from app.scraper_tools import validate_public_url
    provider.save_key(SecretStr('tvly-extract-ssrf-credential'))
    post_payloads = []
    def handler(request):
        if request.method == 'GET':
            return httpx.Response(200, json=usage(used=10))
        post_payloads.append(json.loads(request.content))
        return httpx.Response(200, json={
            'results': [{'url': 'https://example.com/empty', 'raw_content': '   '}],
            'failed_results': [{'url': 'https://example.com/blocked', 'error': 'Failed to fetch'}],
        })
    transport(monkeypatch, handler)
    extracted = asyncio.run(provider.tavily_extract([
        'http://127.0.0.1:8000/internal',
        'http://169.254.169.254/latest/meta-data/',
        'https://example.com/empty',
    ], validate_url=validate_public_url))
    assert extracted.results == {}
    assert 'http://127.0.0.1:8000/internal' in extracted.failed
    assert 'http://169.254.169.254/latest/meta-data/' in extracted.failed
    assert len(post_payloads) == 1
    assert post_payloads[0]['urls'] == ['https://example.com/empty']
