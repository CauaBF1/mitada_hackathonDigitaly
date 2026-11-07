import asyncio

import pytest

from app import tools
from app.config import settings
from app.scraper_tools import MarketScraper, ScrapingError, parse_reputation
from app.web_policy import AccessPolicy
from test_real_market import product


def test_queued_connection_does_not_expire_before_network_starts(monkeypatch):
    async def run():
        monkeypatch.setattr(settings, 'scrape_timeout_seconds', 2)
        async def validate(url): return '93.184.216.34'
        async def pace(*args): pass
        monkeypatch.setattr(tools, 'validate_public_url', validate)
        monkeypatch.setattr(AccessPolicy, 'pace', pace)
        monkeypatch.setattr(tools, 'read_page', lambda *args: (200, {}, '<h1>Product</h1>'))
        async with tools.RealMarketScraper() as scraper:
            scraper.semaphore = asyncio.Semaphore(0)
            task = asyncio.create_task(scraper.raw_fetch('https://example.com/product'))
            await asyncio.sleep(8.1)
            assert not task.done()
            scraper.semaphore.release()
            assert (await asyncio.wait_for(task, 2))[0] == 200
    asyncio.run(run())


@pytest.mark.parametrize('status', [200, 403])
def test_concurrent_pages_share_one_robots_request_and_failure_is_bounded(status):
    async def run():
        AccessPolicy.cache.clear()
        calls = []
        async def fetch(url):
            calls.append(url)
            await asyncio.sleep(.02)
            return status, {'content-type': 'text/plain'}, 'User-agent: *\nAllow: /', url
        results = await asyncio.gather(*(AccessPolicy(fetch).allow('https://example.com/p'+str(i)) for i in range(20)), return_exceptions=True)
        assert len(calls) == 1
        if status == 200:
            assert results == [None] * 20
        else:
            assert all(isinstance(result, ScrapingError) for result in results)
            with pytest.raises(ScrapingError): await AccessPolicy(fetch).allow('https://example.com/other')
            assert len(calls) == 1
        AccessPolicy.cache.clear()
    asyncio.run(run())


def test_reputation_search_uses_supplier_domain_and_normalizes_official_subpages():
    async def run():
        async with MarketScraper() as scraper:
            async def search(query):
                assert '"store-0.com"' in query and '"Store A"' not in query
                return ['https://www.reclameaqui.com.br/empresa/store/lista-reclamacoes/?page=2']
            async def fetch(url):
                assert url == 'https://www.reclameaqui.com.br/empresa/store/'
                return '<h1>Store A</h1><a href="https://store-0.com">Site</a>Reputação Boa. Nota média nos últimos 6 meses: 8/10.', url
            scraper.search, scraper.fetch = search, fetch
            assert (await scraper.reputation(product())).approved
    asyncio.run(run())


def test_bad_reputation_label_is_not_approved_even_with_conflicting_high_score():
    text = '<h1>Store A</h1><a href="https://store-0.com">Site</a>Reputação Não recomendada. Nota média nos últimos 6 meses: 8/10.'
    assert not parse_reputation(text, 'https://www.reclameaqui.com.br/empresa/store/', product()).approved
