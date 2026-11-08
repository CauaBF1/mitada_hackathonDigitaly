import asyncio
import json
from decimal import Decimal

import pytest

from app.config import settings
from app.scraper_tools import MarketScraper, ProductOffer, ScrapingError, SearchCandidate, parse_extracted_product, parse_product, product_links, same_product
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
    assert same_product('televisão hisense 43 polegadas 4k', 'Smart TV 43" Hisense 4K UHD 43A6N')
    assert same_product('televisão hisense 43 polegadas 4k', 'Smart TV Hisense 43A6K LED 4K UHD')
    assert not same_product('televisão hisense 43 polegadas 4k', 'Smart TV Hisense 50" 4K UHD')


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


def test_tavily_extract_fallback_recovers_blocked_direct_fetch_with_validated_offer(monkeypatch):
    from app import scraper_tools
    from app.search_provider import TavilyExtraction
    query = 'Televisão Hisense 43 polegadas 4K'
    blocked_url = 'https://www.fastshop.com.br/web/p/d/smart-tv-hisense-43-4k-43a6k'
    markdown = '''# Smart TV Hisense 43" 4K UHD 43A6K
Vendido e entregue por Fast Shop
De R$ 2.299,00
Por R$ 1.799,00 à vista no Pix
ou 10x de R$ 199,90 sem juros'''
    async def allow_url(url):
        return '93.184.216.34'
    async def fake_tavily_extract(urls, *, query=None, extract_depth='basic', validate_url=None, **kwargs):
        assert urls == [blocked_url]
        return TavilyExtraction(results={blocked_url: markdown}, failed={}, extract_depth=extract_depth, credits_used=1, request_id='test-req')
    monkeypatch.setattr(scraper_tools, 'validate_public_url', allow_url)
    monkeypatch.setattr(scraper_tools, 'tavily_extract', fake_tavily_extract)
    async def run():
        async with MarketScraper() as scraper:
            async def search(q):
                return [blocked_url]
            async def fetch(url):
                raise ScrapingError('HTTP 403')
            scraper.search, scraper.fetch = search, fetch
            return await scraper.discover(query)
    result = asyncio.run(run())
    assert len(result.products) == 1
    offer = result.products[0]
    assert offer.product_url == blocked_url
    assert offer.price == Decimal('1799.00')
    assert offer.currency == 'BRL'
    assert offer.extraction_method.startswith('tavily_extract/')
    assert 'vista' in (offer.price_basis or '')
    assert offer.shipping_fee is None
    assert offer.additional_costs is None
    assert offer.availability == "Unknown"
    assert len(offer.evidence_sha256) == 64
    assert result.tavily_extractions == 1
    assert result.tavily_credits_used == 1
    assert result.blocked_sites == 0


def test_tavily_extract_rejects_installments_third_party_seller_wrong_variant_and_parts():
    query = 'Televisão Hisense 43 polegadas 4K'
    url = 'https://www.magazineluiza.com.br/smart-tv-hisense-43-4k/p/12345/'
    # 1. Installment only without confirmed cash/total price
    with pytest.raises(ScrapingError, match='parcelad'):
        parse_extracted_product('# Smart TV Hisense 43" 4K UHD\nApenas 10x de R$ 189,90 sem juros', url, query)
    # 2. Third-party marketplace seller on store domain
    with pytest.raises(ScrapingError, match='terceiro'):
        parse_extracted_product('# Smart TV Hisense 43" 4K UHD\nVendido por Mega Eletrônicos e entregue por Magalu\nPreço à vista R$ 1.799,00', url, query)
    # 3. Wrong variant (50 inches instead of 43 inches)
    with pytest.raises(ScrapingError, match='não corresponde'):
        parse_extracted_product('# Smart TV Hisense 50" 4K UHD 50A6K\nVendido e entregue por Magalu\nPreço à vista R$ 2.199,00', url, query)
    # 4. Replacement part / accessory
    with pytest.raises(ScrapingError, match='não corresponde'):
        parse_extracted_product('# Controle Remoto para Smart TV Hisense 43" 4K\nVendido e entregue por Magalu\nPreço à vista R$ 49,90', url, query)
    assert not same_product(query, 'Placa Principal TV Hisense 43 Polegadas 4K 43A6K')
    assert not same_product(query, 'Barra de LED TV Hisense 43 Polegadas 4K')


@pytest.mark.parametrize('price_line', [
    'R$\xa0175,99-15%à vista no PIX',
    '**R$ 175,99** -15% **à vista no PIX**',
    'R$ 175,99 − 15,5% à vista no PIX',
])
def test_tavily_kabum_cash_price_with_adjacent_discount_badge(price_line):
    # Layout reproduced from a real Tavily Extract response for this product.
    url = 'https://www.kabum.com.br/produto/495499/teclado-pebble-keys-2-k380s'
    content = ('# Teclado Sem Fio Logitech Pebble Keys 2 K380s\n'
               'Vendido e entregue por:**KaBuM!**\n\nR$\xa0258,81\n\n'
               f'{price_line}\n\n**8x R$\xa025,88** s/ juros\n'
               '## Produtos relacionados\nMouse Logitech\nPor R$ 39,90 à vista no PIX')
    offer = parse_extracted_product(content, url, 'Teclado pebble keys 2')
    assert offer.price == Decimal('175.99')
    assert offer.extraction_method == 'tavily_extract/basic'
    assert offer.availability == 'Unknown'


@pytest.mark.parametrize('price_line', [
    '**8x R$ 25,88** à vista no PIX',
    'Desconto R$ 25,88 -15% à vista no PIX',
    'Frete R$ 25,88 -15% à vista no PIX',
    'De R$ 258,81 -15% à vista no PIX',
])
def test_tavily_discount_badge_does_not_make_non_total_amount_a_cash_price(price_line):
    with pytest.raises(ScrapingError):
        parse_extracted_product(f'# {NAME}\n{price_line}', URL, NAME)


def test_discover_differentiates_local_filters_robots_skips_and_remote_blocks_while_preserving_valid_offers():
    valid_url = 'https://store.example/prod/mouse-m170'
    robots_url = 'https://robots-blocked.example/prod/mouse-m170'
    http_blocked_url = 'https://waf-blocked.example/prod/mouse-m170'
    filtered_url = 'https://www.buscape.com.br/mouse-logitech-m170'
    async def run():
        async with MarketScraper() as scraper:
            async def search(q):
                return [filtered_url, valid_url, robots_url, http_blocked_url]
            async def fetch(url):
                if url == valid_url:
                    return microdata(), url
                if url == robots_url:
                    raise ScrapingError('Bloqueado por robots.txt')
                raise ScrapingError('HTTP 403')
            async def extract_fallback(url, q):
                return None
            scraper.search, scraper.fetch, scraper.extract_fallback = search, fetch, extract_fallback
            return await scraper.discover(NAME)
    result = asyncio.run(run())
    assert len(result.products) == 1
    assert result.products[0].product_url == valid_url
    assert result.filtered_domains == 1
    assert result.policy_skipped_sites == 1
    assert result.blocked_sites == 1
    assert any('waf-blocked.example' in err for err in result.errors)



@pytest.mark.parametrize('seller', ['Magalu Outlet Terceiro', 'Loja parceira Magalu', 'MagaluExpress'])
def test_extracted_seller_requires_exact_store_identity(seller):
    with pytest.raises(ScrapingError, match='terceiro'):
        parse_extracted_product(f'# Smart TV Hisense 43" 4K UHD\nVendido por {seller}\nPor R$ 1.799,00 à vista',
            'https://www.magazineluiza.com.br/tv/p/12345/', 'TV Hisense 43 4K')


def test_extract_budget_is_reserved_before_concurrent_calls(monkeypatch):
    from app import scraper_tools
    from app.search_provider import TavilyExtraction
    calls = []
    async def fake_extract(urls, **kwargs):
        calls.append(urls)
        await asyncio.sleep(0.01)
        return TavilyExtraction(credits_used=1)
    monkeypatch.setattr(scraper_tools, 'tavily_extract', fake_extract)
    monkeypatch.setattr(settings, 'tavily_extract_max_credits_per_task', 1)
    monkeypatch.setattr(settings, 'tavily_extract_max_retries', 2)
    async def run():
        async with MarketScraper() as scraper:
            return await asyncio.gather(*(scraper.bounded_extract(f'https://store.example/p/{i}', 'basic') for i in range(3)), return_exceptions=True)
    results = asyncio.run(run())
    assert len(calls) == 1
    assert sum(isinstance(r, ScrapingError) for r in results) == 2
