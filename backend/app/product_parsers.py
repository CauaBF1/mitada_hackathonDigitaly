import re
from urllib.parse import urlsplit

from bs4 import BeautifulSoup


def value(tag):
    if tag is None:
        return None
    return tag.get('content') or tag.get('href') or tag.get('value') or tag.get_text(' ', strip=True)


def scoped_property(scope, name):
    rows = [tag for tag in scope.select(f'[itemprop~="{name}"]') if tag.find_parent(attrs={'itemscope': True}) is scope]
    values = list(dict.fromkeys(value(tag) for tag in rows if value(tag)))
    return values[0] if len(values) == 1 else None


def page_availability(soup):
    stock = soup.select_one('.product-info-main .stock, .product-info .stock, [itemprop="availability"]')
    if stock is None:
        return 'Unknown'
    text = value(stock) or ''
    if re.search(r'OutOfStock|SoldOut|indispon[ií]vel|esgotado|fora de estoque|out.of.stock', text, re.I):
        return 'OutOfStock'
    if re.search(r'InStock|em estoque|in.stock', text, re.I):
        return 'InStock'
    return 'Unknown'


def html_product_nodes(soup: BeautifulSoup, url: str):
    nodes = []
    heading = soup.find('h1')
    for scope in soup.select('[itemscope][itemtype]'):
        if scope.get('itemtype', '').rstrip('/').rsplit('/', 1)[-1] != 'Product':
            continue
        name = scoped_property(scope, 'name')
        if not name or heading is None:
            continue
        offers = []
        for tag in scope.select('[itemprop~="offers"][itemscope][itemtype]'):
            if tag.find_parent(attrs={'itemscope': True}) is not scope or tag.get('itemtype', '').rsplit('/', 1)[-1] != 'Offer':
                continue
            offers.append({'@type': 'Offer', 'price': scoped_property(tag, 'price'), 'priceCurrency': scoped_property(tag, 'priceCurrency'), 'availability': scoped_property(tag, 'availability') or page_availability(soup), 'priceValidUntil': scoped_property(tag, 'priceValidUntil'), 'url': scoped_property(tag, 'url') or url})
        nodes.append({'@type': 'Product', 'name': name, 'url': url, 'offers': offers, '_extraction_method': 'schema.org/Product.microdata'})

    def meta(name):
        values = {value(tag) for tag in soup.select(f'meta[property="{name}"]') if value(tag)}
        return next(iter(values)) if len(values) == 1 else None

    if meta('og:type') in {'product', 'og:product'} and heading is not None:
        nodes.append({'@type': 'Product', 'name': heading.get_text(' ', strip=True), 'url': meta('og:url') or url, 'offers': {'@type': 'Offer', 'price': meta('product:price:amount'), 'priceCurrency': meta('product:price:currency'), 'availability': meta('product:availability') or page_availability(soup), 'url': meta('og:url') or url}, '_extraction_method': 'OpenGraph.product:price'})

    if (urlsplit(url).hostname or '').lower() in {'kalunga.com.br', 'www.kalunga.com.br'} and urlsplit(url).path.startswith('/prod/'):
        container = soup.select_one('#container_produto')
        if container is not None:
            title = container.select_one('h1')
            prices = container.select('#content_info_produto p.produtoinfos__price#precovista')
            purchase = container.select_one('#ComprarComGarantia:not([disabled]):not([aria-disabled="true"]):not([hidden]), .produtoinfos__button--comprar:not([disabled]):not([aria-disabled="true"]):not([hidden])')
            if title is not None and len(prices) == 1 and purchase is not None:
                match = re.fullmatch(r'R\$\s*([\d.]+,\d{2})\s*(?:à vista)?', prices[0].get_text(' ', strip=True))
                if match:
                    price = match[1].replace('.', '').replace(',', '.')
                    nodes.append({'@type': 'Product', 'name': title.get_text(' ', strip=True), 'url': url, 'offers': {'@type': 'Offer', 'price': price, 'priceCurrency': 'BRL', 'availability': 'InStock', 'url': url}, '_extraction_method': 'merchant_html/kalunga.product_cash_price', '_price_basis': 'Preço à vista publicado no painel do produto; frete e estoque para a quantidade sujeitos à confirmação.'})
    return nodes
