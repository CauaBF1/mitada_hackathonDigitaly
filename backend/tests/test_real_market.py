import asyncio
import json
from decimal import Decimal

import pytest

from app import orchestrator as flow
from app.scraper_tools import Discovery, MarketScraper, ProductOffer, Reputation, ScrapingError, parse_product, parse_reputation, search_result_url, timestamp, validate_public_url


def product_html(name='Mouse Logitech M170', price='100.00', **overrides):
    offer = {'@type': 'Offer', 'price': price, 'priceCurrency': 'BRL', 'availability': 'https://schema.org/InStock', **overrides}
    return '<html><head><meta property="og:site_name" content="Store A"><script type="application/ld+json">' + json.dumps({'@type': 'Product', 'name': name, 'offers': offer}) + '</script></head><body><h1>' + name + '</h1></body></html>'


def product(index=0, price='100.00'):
    return parse_product(product_html(price=price), f'https://store-{index}.com/item/m170', 'Mouse Logitech M170').model_copy(update={'additional_costs': []})


def test_parses_offer_with_source_and_provenance():
    row = product()
    assert row.price == Decimal('100.00')
    assert row.product_url == 'https://store-0.com/item/m170'
    assert row.supplier_name == 'Store A'
    assert row.extraction_method == 'schema.org/Product.offers'
    assert len(row.evidence_sha256) == 64
    assert row.currency == 'BRL'


@pytest.mark.parametrize('changes', [
    {'name': 'Mouse Logitech M185'}, {'name': 'Capa para Mouse Logitech M170'},
    {'price': 'NaN'}, {'price': '0'}, {'price': '1.000,00'}, {'price': True},
    {'priceCurrency': 'USD'}, {'availability': 'https://schema.org/OutOfStock'},
    {'priceValidUntil': '2001-01-01'}, {'@type': 'AggregateOffer'},
])
def test_rejects_noncomparable_stale_ambiguous_and_unavailable_offers(changes):
    with pytest.raises(ScrapingError):
        parse_product(product_html(**changes), 'https://store.com/p/m170', 'Mouse Logitech M170')


def test_does_not_infer_prices_from_text_or_search_snippets():
    with pytest.raises(ScrapingError):
        parse_product('<h1>Mouse Logitech M170</h1><p>R$ 1,00 por mês</p>', 'https://store.com/p/m170', 'Mouse Logitech M170')


def test_category_url_is_never_presented_as_a_product_url():
    html = product_html().replace('<h1>Mouse Logitech M170</h1>', '<h1>Mouses</h1>')
    with pytest.raises(ScrapingError):
        parse_product(html, 'https://store.com/category/mouses', 'Mouse Logitech M170')


def test_ra_score_is_current_six_month_score_and_identity_is_checked():
    html = '<h1>Store A</h1><a href="https://store-0.com">Site</a><p>Reputação Ótima</p><p>A nota média nos últimos 6 meses 8.1/10.</p><p>Nota média do consumidor 6.2</p><p>Dados de 01/04/2026 até 30/09/2026</p>'
    row = parse_reputation(html, 'https://www.reclameaqui.com.br/empresa/store-a/', product())
    assert row.score == Decimal('8.1')
    assert row.verified and row.approved
    assert '30/09/2026' in row.period
    with pytest.raises(ScrapingError):
        parse_reputation(html.replace('store-0.com', 'different.com'), row.url, product())
    with pytest.raises(ScrapingError):
        parse_reputation(html.replace('A nota média nos últimos 6 meses 8.1/10.', ''), row.url, product())


def test_private_urls_and_credentials_rejected():
    for url in ('http://127.0.0.1/secret', 'http://169.254.169.254/latest', 'http://[::1]/', 'http://user:secret@example.com/'):
        with pytest.raises(ScrapingError):
            asyncio.run(validate_public_url(url))


def test_search_urls_are_decoded_without_inventing_product_links():
    assert search_result_url('/url?q=https%3A%2F%2Fstore.com%2Fproduct', 'https://www.google.com/search') == 'https://store.com/product'
    assert search_result_url('javascript:alert(1)', 'https://www.bing.com') is None


