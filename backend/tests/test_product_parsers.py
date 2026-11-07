import asyncio
import json
from decimal import Decimal

import pytest

from app.config import settings
from app.scraper_tools import MarketScraper, ProductOffer, ScrapingError, SearchCandidate, parse_product, product_links, same_product
from test_real_market import product_html


URL = 'https://store.example/prod/mouse-m170'
NAME = 'Mouse Logitech M170'


def microdata(price='100.00', currency='BRL', stock='Em estoque'):
    return f'''<html><meta property="og:site_name" content="Loja de teste"><body itemscope itemtype="https://schema.org/Product"><h1 itemprop="name">{NAME}</h1><div class="product-info-main"><div class="stock">{stock}</div></div><span itemprop="offers" itemscope itemtype="https://schema.org/Offer"><meta itemprop="price" content="{price}"><meta itemprop="priceCurrency" content="{currency}"></span></body></html>'''


def opengraph(price='100.00', availability='in stock'):
    return f'''<h1>{NAME}</h1><meta property="og:type" content="product"><meta property="og:site_name" content="Loja de teste"><meta property="product:price:amount" content="{price}"><meta property="product:price:currency" content="BRL"><meta property="product:availability" content="{availability}">'''


def test_microdata_binds_price_to_product_and_ignores_nested_review():
    html = microdata().replace('</body>', '<section itemscope itemtype="https://schema.org/Review"><span itemprop="name">Outra coisa</span><meta itemprop="price" content="1.00"></section></body>')
    row = parse_product(html, URL, NAME)
    assert row.price == Decimal('100.00') and row.product_name == NAME
    assert row.extraction_method == 'schema.org/Product.microdata'
    assert row.availability == 'InStock'
    assert len(row.evidence_sha256) == 64


@pytest.mark.parametrize('html', [microdata(stock='Fora de estoque'), microdata(currency='USD'), microdata(price='8.333'), opengraph(availability='out of stock'), opengraph().replace('content="product"', 'content="website"')])
def test_html_fallback_does_not_accept_unavailable_or_ambiguous_prices(html):
    with pytest.raises(ScrapingError):
        parse_product(html, URL, NAME)


def test_opengraph_price_has_a_specific_product_identity():
    row = parse_product(opengraph(), URL, NAME)
    assert row.price == Decimal('100.00')
    assert row.extraction_method == 'OpenGraph.product:price'
    with pytest.raises(ScrapingError):
        parse_product(opengraph().replace(NAME, 'Mouses em promoção'), URL, NAME)


@pytest.mark.parametrize('changes', [{'availability': 'https://schema.org/OutOfStock'}, {'priceValidUntil': '2001-01-01'}])
def test_metadata_cannot_resurrect_expired_or_unavailable_jsonld_offer(changes):
    with pytest.raises(ScrapingError):
        parse_product(product_html(**changes) + opengraph(), URL, NAME)


def test_resolves_offer_id_and_explicit_unit_price_specification():
    data = {'@graph': [{'@type': 'https://schema.org/Product', 'name': NAME, 'offers': {'@id': '#offer'}}, {'@type': 'Offer', '@id': '#offer', 'priceSpecification': {'@type': 'UnitPriceSpecification', 'price': '123.45', 'priceCurrency': 'BRL'}}]}
    html = f'<meta property="og:site_name" content="Loja"><h1>{NAME}</h1><script type="application/ld+json">{json.dumps(data)}</script>'
    assert parse_product(html, URL, NAME).price == Decimal('123.45')
    data['@graph'][1]['priceSpecification']['billingDuration'] = 'P1M'
    with pytest.raises(ScrapingError):
        parse_product(f'<meta property="og:site_name" content="Loja"><h1>{NAME}</h1><script type="application/ld+json">{json.dumps(data)}</script>', URL, NAME)


def test_kalunga_reads_only_the_primary_cash_price_panel():
    html = f'''<meta property="og:site_name" content="Kalunga"><div id="container_produto"><h1>{NAME}</h1><div id="content_info_produto"><p class="produtoinfos__price" id="precovista">R$ 218,41 <span>à vista</span></p><span>3x R$ 76,63</span><button id="ComprarComGarantia">Comprar</button></div><span id="precovista">R$ 1.027,71 à vista</span></div>'''
    url = 'https://www.kalunga.com.br/prod/mouse-logitech/1234'
    row = parse_product(html, url, NAME)
    assert row.price == Decimal('218.41')
    assert row.extraction_method == 'merchant_html/kalunga.product_cash_price'
    assert 'vista' in row.price_basis
    with pytest.raises(ScrapingError):
        parse_product(html.replace('id="ComprarComGarantia"', 'id="ComprarComGarantia" disabled'), url, NAME)
    with pytest.raises(ScrapingError):
        parse_product(html, URL, NAME)


def test_category_exploration_follows_itemlist_urls_and_excludes_bundles():
    html = '<title>Mouse Logitech</title><script type="application/ld+json">' + json.dumps({'@type': 'ItemList', 'itemListElement': [{'@type': 'ListItem', 'url': 'https://store.example/p/m170'}]}) + '</script><a href="/bundle">Combo teclado e mouse Logitech</a><a href="/p/m185">Mouse Logitech M185</a>'
    links = product_links(html, 'https://store.example/category/mice', 'mouse logitech')
    assert 'https://store.example/p/m170' in links
    assert not any('bundle' in link for link in links)
    assert not same_product('mouse logitech', 'Combo Teclado e Mouse Logitech MK880')
    assert same_product('teclado e mouse logitech', 'Combo Teclado e Mouse Logitech MK880')


def test_discovery_reaches_real_html_offer_from_category_and_streams_it(monkeypatch):
    updates = []
    async def run():
        async with MarketScraper() as scraper:
            async def search(query):
                return ['https://store.example/category']
            async def fetch(url):
                return ('<a href="/prod/mouse-m170">Mouse Logitech M170</a>', url) if url.endswith('category') else (microdata(), url)
            async def progress(result):
                updates.append(result)
            scraper.search, scraper.fetch, scraper.on_progress = search, fetch, progress
            return await scraper.discover(NAME)
    result = asyncio.run(run())
    assert len(result.products) == 1
    assert result.products[0].product_url == URL
    assert any(r.products for r in updates)
    assert not result.errors


def test_additional_search_only_runs_when_no_product_was_verified():
    async def run():
        calls = []
        async with MarketScraper() as scraper:
            async def search(query):
                calls.append(query)
                return [URL] if len(calls) == 3 else ['https://store.example/category']
            async def fetch(url):
                return ('<h1>Categoria vazia</h1>', url) if url.endswith('category') else (microdata(), url)
            scraper.search, scraper.fetch = search, fetch
            result = await scraper.discover(NAME)
        return calls, result
    queries, result = asyncio.run(run())
    assert len(queries) == 3 and len(result.products) == 1
    assert result.candidates[0].error


def test_dns_resolution_is_bounded(monkeypatch):
    from app import scraper_tools
    async def run():
        async def stalled(*args, **kwargs):
            raise TimeoutError()
        monkeypatch.setattr(asyncio.get_running_loop(), 'getaddrinfo', stalled)
        with pytest.raises(ScrapingError, match='resolver'):
            await scraper_tools.validate_public_url('https://example.com/product')
    asyncio.run(run())
