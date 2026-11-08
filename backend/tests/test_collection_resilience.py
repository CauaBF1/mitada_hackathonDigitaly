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


def test_reputation_tavily_extract_fallback_verifies_ra1000_company_when_direct_fetch_blocked(monkeypatch):
    from app import scraper_tools
    from app.search_provider import TavilyExtraction
    ra_url = 'https://www.reclameaqui.com.br/empresa/store/'
    markdown = '''# Store A
Site oficial: https://store-0.com/atendimento
Reputação
RA1000
Nota nos últimos 6 meses: 9.1 / 10'''
    async def allow_url(url):
        return '93.184.216.34'
    async def fake_tavily_extract(urls, *, extract_depth='basic', validate_url=None, **kwargs):
        assert urls == [ra_url]
        return TavilyExtraction(results={ra_url: markdown}, failed={}, extract_depth=extract_depth, credits_used=1, request_id='ra-test')
    monkeypatch.setattr(scraper_tools, 'validate_public_url', allow_url)
    monkeypatch.setattr(scraper_tools, 'tavily_extract', fake_tavily_extract)
    async def run():
        async with MarketScraper() as scraper:
            async def search(query):
                return [ra_url]
            async def fetch(url):
                raise ScrapingError('HTTP 403')
            scraper.search, scraper.fetch = search, fetch
            return await scraper.reputation(product())
    rep = asyncio.run(run())
    assert rep.verified is True
    assert rep.approved is True
    assert str(rep.score) == '9.1'
    assert rep.scale == 10
    assert rep.period == 'Últimos 6 meses'
    assert rep.classification == 'RA1000'
    assert rep.label == 'RA1000'
    assert rep.source == 'reclameaqui.com.br'
    assert rep.extraction_method == 'tavily_extract/basic'
    assert rep.status == 'verified'


@pytest.mark.parametrize('markdown,expected_status', [
    ('# Outra Empresa\nSite: https://outra-loja.com.br\nReputação Ótimo. Nota média nos últimos 6 meses: 8.5/10.', 'unconfirmed_identity'),
    ('# Store A\nSite: https://store-0.com\nReputação Boa. Nota do consumidor: 8.4 / 10.', 'insufficient_content'),
    ('# Store A\nSite: https://store-0.com\nReputação Boa. Nota nos últimos 12 meses: 8.4/10.', 'outdated_period'),
    ('# Store A\nSite: https://store-0.com\nReputação Sem índice. A empresa não tem avaliações suficientes nos últimos 6 meses.', 'unrated'),
])
def test_reputation_rejects_wrong_company_consumer_score_invalid_period_and_unrated(markdown, expected_status):
    from app.scraper_tools import ReputationError
    ra_url = 'https://www.reclameaqui.com.br/empresa/store/'
    with pytest.raises(ReputationError) as exc_info:
        parse_reputation(markdown, ra_url, product(), extraction_method='tavily_extract/reclame_aqui')
    assert exc_info.value.status == expected_status


def test_online_reputation_rejects_separate_physical_store_profile():
    from app.scraper_tools import parse_reputation, ReputationError, ProductOffer
    offer = ProductOffer(supplier_name="Cobasi", supplier_domain="cobasi.com.br", supplier_website="https://www.cobasi.com.br",
        product_name="Item", product_url="https://www.cobasi.com.br/item", price="10.00", availability="Unknown",
        observed_at="2026-11-08", extraction_method="test", evidence_sha256="a" * 64)
    with pytest.raises(ReputationError, match="loja física"):
        parse_reputation('# Cobasi - Loja Física é confiável?\nSite: https://www.cobasi.com.br\nNota média nos últimos 6 meses 7,9/10',
            'https://www.reclameaqui.com.br/empresa/cobasi/', offer, extraction_method='tavily_extract/basic')
