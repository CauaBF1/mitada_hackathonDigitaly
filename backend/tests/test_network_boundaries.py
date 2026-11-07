import asyncio
from types import SimpleNamespace

import httpx
import pytest
import requests
from pydantic import SecretStr, ValidationError

from app import agent, agent_intelligence, scraper_tools, tools
from app.config import settings
from app.scraper_tools import MarketScraper, ScrapingError, SearchCandidate, merchant_search_url
from app.web_policy import AccessPolicy
from test_real_market import product, product_html


@pytest.mark.parametrize('status,mime,chunks,expected', [
    (200, 'text/html', [b'<h1>Product</h1>'], '<h1>Product</h1>'),
    (301, 'text/html', [], ''), (404, 'text/plain', [], ''),
    (403, 'text/html', [], None), (429, 'text/html', [], None),
    (200, 'application/octet-stream', [], None), (200, 'text/html', [b'x' * 11], None),
])
def test_requests_reader_checks_status_content_limit_and_pins_network(monkeypatch, status, mime, chunks, expected):
    captured = {}
    class Session:
        def __enter__(self): return self
        def __exit__(self, *args): captured['closed'] = True
        def mount(self, scheme, adapter):
            assert adapter.address == '93.184.216.34' and adapter.hostname == 'example.com'
        def get(self, url, **kwargs):
            assert self.trust_env is False
            assert kwargs['allow_redirects'] is False and kwargs['stream'] is True
            assert kwargs['headers']['Host'] == 'example.com'
            return SimpleNamespace(status_code=status, headers={'content-type': mime}, encoding='utf-8', raise_for_status=lambda: None, iter_content=lambda size: chunks)
    monkeypatch.setattr(tools.requests, 'Session', Session)
    monkeypatch.setattr(tools, 'MAX_PAGE_BYTES', 10 if len(chunks) and chunks[0] == b'x' * 11 else 100)
    url = 'https://example.com/robots.txt' if status == 404 else 'https://example.com/product'
    if expected is None:
        with pytest.raises(ScrapingError): tools.read_page(url, '93.184.216.34')
    else:
        assert tools.read_page(url, '93.184.216.34')[2] == expected
    assert captured['closed']


def test_requests_timeout_is_sanitized(monkeypatch):
    def fail(*args, **kwargs): raise requests.Timeout('sensitive server diagnostic')
    monkeypatch.setattr(requests.Session, 'get', fail)
    with pytest.raises(ScrapingError, match='Falha de conexão') as error:
        tools.read_page('https://example.com/product', '93.184.216.34')
    assert 'sensitive' not in str(error.value)


def test_parallel_redirect_robots_do_not_deadlock_and_every_hop_is_validated(monkeypatch):
    async def run():
        AccessPolicy.cache.clear()
        checked = []
        async def validate(url):
            checked.append(url)
            return '93.184.216.34'
        async def pace(*args, **kwargs): pass
        def read(url, address):
            if url.endswith('robots.txt'): return 200, {'content-type': 'text/plain'}, 'User-agent: *\nAllow: /'
            if 'example.com' in url: return 302, {'Location': url.replace('example.com', 'example.org')}, ''
            return 200, {'content-type': 'text/html'}, '<h1>Product</h1>'
        monkeypatch.setattr(tools, 'validate_public_url', validate)
        monkeypatch.setattr(tools, 'read_page', read)
        monkeypatch.setattr(AccessPolicy, 'pace', pace)
        async with tools.RealMarketScraper() as scraper:
            results = await asyncio.wait_for(asyncio.gather(*(scraper.fetch(f'https://example.com/product-{i}') for i in range(6))), 3)
        assert all(final.startswith('https://example.org') for _, final in results)
        assert 'https://example.org/robots.txt' in checked
        assert len([url for url in checked if 'product-' in url]) == 12
    asyncio.run(run())


def test_redirect_to_private_network_is_rejected_before_read(monkeypatch):
    async def run():
        reads = []
        async def validate(url):
            if '127.0.0.1' in url: raise ScrapingError('privado')
            return '93.184.216.34'
        async def pace(*args, **kwargs): pass
        def read(url, address):
            reads.append(url)
            return 302, {'Location': 'http://127.0.0.1/private'}, ''
        monkeypatch.setattr(tools, 'validate_public_url', validate)
        monkeypatch.setattr(tools, 'read_page', read)
        monkeypatch.setattr(AccessPolicy, 'pace', pace)
        async with tools.RealMarketScraper() as scraper:
            with pytest.raises(ScrapingError): await scraper.raw_fetch('https://example.com/product')
        assert reads == ['https://example.com/product']
    asyncio.run(run())


def test_access_policy_pacing_and_excessive_crawl_delay(monkeypatch):
    async def run():
        AccessPolicy.next_access.clear(); AccessPolicy.cache.clear()
        delays = []
        async def sleep(seconds): delays.append(seconds)
        async def fetch(url): return 200, {}, 'User-agent: *\nCrawl-delay: 60', url
        monkeypatch.setattr('app.web_policy.asyncio.sleep', sleep)
        monkeypatch.setattr('app.web_policy.time.monotonic', lambda: 100)
        policy = AccessPolicy(fetch)
        await policy.pace('https://example.com/a')
        await policy.pace('https://example.com/b')
        assert delays == [1]
        with pytest.raises(ScrapingError): await policy.allow('https://example.com/product')
        AccessPolicy.cache.clear(); AccessPolicy.next_access.clear()
    asyncio.run(run())


def test_search_results_deduplicate_and_reject_nonweb_urls(monkeypatch):
    async def results(query): return [{'url': url, 'title': 'Product', 'description': ''} for url in ['https://example.com/product', 'https://example.com/product', 'file:///etc/passwd']]
    monkeypatch.setattr(scraper_tools, 'tavily_results', results)
    async def run():
        async with MarketScraper() as scraper:
            assert await scraper.search('mouse') == ['https://example.com/product']
            assert len(scraper.search_candidates) == 1
    asyncio.run(run())


@pytest.mark.parametrize('engine', ['brave', 'public', 'blocked'])
def test_search_fallbacks_preserve_real_links_or_explicit_failure(monkeypatch, engine):
    async def no_tavily(query): return None
    monkeypatch.setattr(scraper_tools, 'tavily_results', no_tavily)
    monkeypatch.setattr(settings, 'brave_search_api_key', SecretStr('test-only') if engine == 'brave' else None)
    async def run():
        async with MarketScraper() as scraper:
            await scraper.client.aclose()
            scraper.client = httpx.AsyncClient(transport=httpx.MockTransport(lambda request: httpx.Response(200, json={'web': {'results': [{'url': 'https://example.com/product'}]}})))
            async def fetch(url):
                if engine == 'blocked': raise ScrapingError('bloqueado')
                return '<li class="b_algo"><h2><a href="https://example.com/product">Mouse</a></h2></li>', url
            scraper.fetch = fetch
            if engine == 'blocked':
                with pytest.raises(ScrapingError, match='Nenhum resultado foi inventado'): await scraper.search('mouse')
            else: assert await scraper.search('mouse') == ['https://example.com/product']
    asyncio.run(run())


def test_supplier_reputation_uses_official_company_page_and_domain_identity():
    async def run():
        async with MarketScraper() as scraper:
            async def search(query): return ['https://evil.example/empresa/store/', 'https://www.reclameaqui.com.br/empresa/store/']
            async def fetch(url):
                assert url.startswith('https://www.reclameaqui.com.br/empresa/')
                return '<h1>Store A</h1><a href="https://store-0.com">Site</a>Nota média nos últimos 6 meses: 8/10.', url
            scraper.search, scraper.fetch = search, fetch
            result = await scraper.reputation(product())
            assert result.approved and result.score == 8
            async def denied(url): raise ScrapingError('HTTP 403')
            scraper.fetch = denied
            result = await scraper.reputation(product())
            assert result.score is None and not result.approved and result.reason == 'HTTP 403'
    asyncio.run(run())


@pytest.mark.parametrize('html,expected', [
    ('<script type="application/ld+json">{"@type":"SearchAction","target":"https://example.com/search?q={query}"}</script>', 'https://example.com/search?q=Mouse%20Logitech'),
    ('<form action="/search"><input name="q" type="search"></form>', 'https://example.com/search?q=Mouse+Logitech'),
    ('<form action="https://evil.example/"><input name="q"></form>', None),
    ('<form method="post" action="/search"><input name="q"></form>', None),
])
def test_merchant_search_preserves_domain_and_get_only(html, expected):
    assert merchant_search_url(html, 'https://example.com', 'Mouse Logitech') == expected


@pytest.mark.parametrize('models,expected', [(['llama-3.3-70b-versatile'], 'llama-3.3-70b-versatile'), (['openai/gpt-oss-120b'], 'openai/gpt-oss-120b'), ([], None)])
def test_groq_model_discovery_never_fakes_an_available_model(monkeypatch, models, expected):
    monkeypatch.setattr(settings, 'groq_api_key', SecretStr('test-only'))
    real = httpx.AsyncClient
    monkeypatch.setattr(agent.httpx, 'AsyncClient', lambda **kwargs: real(transport=httpx.MockTransport(lambda request: httpx.Response(200, json={'data': [{'id': model} for model in models]})), **kwargs))
    if expected: assert asyncio.run(agent.resolve_model()) == expected
    else:
        with pytest.raises(agent.MessagingError): asyncio.run(agent.resolve_model())


@pytest.mark.parametrize('result', ['valid', 'invalid', 'timeout', 'rate_limit'])
def test_actual_structured_llm_adapter_validates_schema_and_propagates_failures(monkeypatch, result):
    from pydantic import SecretStr
    monkeypatch.setattr(settings, 'llm_provider', 'groq')
    monkeypatch.setattr(settings, 'groq_api_key', SecretStr('test-only'))
    class FakeGroq:
        def __init__(self, **kwargs):
            assert kwargs['max_retries'] == 1 and kwargs['timeout'] == 30
        def with_structured_output(self, schema, method):
            assert method == 'function_calling'
            self.schema = schema
            return self
        async def ainvoke(self, messages):
            assert messages[0][0] == 'system' and messages[1][0] == 'human'
            if result == 'timeout': raise TimeoutError()
            if result == 'rate_limit': raise httpx.HTTPStatusError('rate limited', request=httpx.Request('POST', 'https://example.com'), response=httpx.Response(429))
            return {'unexpected': True} if result == 'invalid' else {'has_previous_history': False, 'historical_discount_avg_pct': None, 'preferred_concession': None, 'tactical_briefing': 'Sem histórico confirmado.'}
    monkeypatch.setattr(agent_intelligence, 'ChatGroq', FakeGroq)
    call = agent_intelligence.memory_intelligence('test-model', {'raw_supplier_history': {}})
    if result == 'valid': assert not asyncio.run(call).has_previous_history
    else:
        with pytest.raises((ValidationError, TimeoutError, httpx.HTTPStatusError)): asyncio.run(call)
