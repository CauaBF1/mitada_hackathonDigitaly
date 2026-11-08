from decimal import Decimal, InvalidOperation
import re
from urllib.parse import urlsplit

from bs4 import BeautifulSoup


_STORE_BRAND_ALIASES: dict[str, set[str]] = {
    'magazineluiza.com.br': {'magalu', 'magazine luiza', 'magazineluiza'},
    'kabum.com.br': {'kabum', 'kabum!'},
    'casasbahia.com.br': {'casas bahia', 'casasbahia'},
    'pontofrio.com.br': {'ponto', 'ponto frio', 'pontofrio'},
    'extra.com.br': {'extra', 'extra.com.br'},
    'amazon.com.br': {'amazon', 'amazon.com.br'},
    'carrefour.com.br': {'carrefour', 'carrefour.com.br'},
    'fastshop.com.br': {'fast shop', 'fastshop'},
    'kalunga.com.br': {'kalunga', 'kalunga.com.br'},
    'zema.com': {'zema', 'lojas zema', 'eletrozema'},
    'bemol.com.br': {'bemol', 'bemol.com.br'},
    'girafa.com.br': {'girafa', 'girafa.com.br'},
    'ferreiracosta.com': {'ferreira costa', 'ferreiracosta'},
    'havan.com.br': {'havan', 'lojas havan'},
}


def _clean_brand_token(value: str) -> str:
    return re.sub(r'[^a-z0-9]+', '', value.casefold())


def _is_first_party_seller(seller_text: str, host: str) -> bool:
    cleaned_seller = seller_text.strip().casefold()
    seller_compact = _clean_brand_token(cleaned_seller)
    if not seller_compact:
        return True
    base_host = host.lower().removeprefix('www.')
    allowed = set(_STORE_BRAND_ALIASES.get(base_host, set()))
    host_label = base_host.split('.')[0]
    if host_label:
        allowed.add(host_label)
    return any(seller_compact == _clean_brand_token(alias) for alias in allowed)



def _to_decimal_brl(raw_brl: str) -> Decimal | None:
    try:
        cleaned = raw_brl.strip().replace('.', '').replace(',', '.')
        val = Decimal(cleaned).quantize(Decimal('0.01'))
        return val if val.is_finite() and val > 0 else None
    except (InvalidOperation, ValueError):
        return None


def extracted_product_nodes(text: str, url: str, extract_depth: str = 'basic') -> tuple[list[dict], str | None]:
    """Parse structured Markdown/text from Tavily Extract into candidate Product nodes with strict validation."""
    if not text or not text.strip():
        return [], 'Conteúdo extraído vazio.'

    soup = BeautifulSoup(text, 'html.parser')
    cleaned = re.sub(r'~~.*?~~', ' ', text, flags=re.S)
    for tag in soup.select('del, s, strike'):
        tag.decompose()

    title: str | None = None
    title_match = re.search(r'(?:^|\n)\s*#\s+([^\n#]{5,240})', cleaned)
    if title_match:
        title = title_match.group(1).strip()
    elif soup.find('h1'):
        title = soup.find('h1').get_text(' ', strip=True)
    else:
        for line in cleaned.splitlines()[:15]:
            stripped = re.sub(r'^[*_\-\s]+|[*_\-\s]+$', '', line.strip())
            if 8 <= len(stripped) <= 220 and not stripped.startswith(('http://', 'https://', '[')):
                title = stripped
                break

    if not title:
        return [], 'Título do produto não identificado no conteúdo extraído.'

    # Strip trailing site suffix like " - Magazine Luiza" or " | KaBuM!"
    title = re.split(r'\s+(?:\||-\s+(?:Magazine Luiza|Magalu|KaBuM!?|Casas Bahia|Amazon\.com\.br|Carrefour|Fast Shop|Kalunga|Zema))\b', title, maxsplit=1, flags=re.I)[0].strip()

    start_idx = cleaned.find(title[:30])
    primary_block = cleaned[start_idx if start_idx >= 0 else 0:]
    cutoff = re.search(
        r'(?:^|\n)\s*(?:#{1,4}\s*)?(?:produtos?\s+relacionados?|quem\s+viu\s+tamb[eé]m|compre\s+junto|aproveite\s+e\s+compre|voc[eê]\s+tamb[eé]m\s+pode\s+gostar|similares|outros\s+clientes|avalia[çc][õo]es\s+de\s+clientes|perguntas\s+e\s+respostas)',
        primary_block,
        re.I,
    )
    if cutoff and cutoff.start() > 40:
        primary_block = primary_block[:cutoff.start()]
    primary_block = primary_block[:3500]

    # 1. Check unavailability
    if re.search(
        r'\b(?:fora\s+de\s+estoque|produto\s+esgotado|esgotado|produto\s+indispon[ií]vel|indispon[ií]vel\s+no\s+momento|sem\s+estoque|out\s+of\s+stock|sold\s+out|avise-me\s+quando\s+chegar|n[aã]o\s+dispon[ií]vel)\b',
        primary_block,
        re.I,
    ):
        return [], 'Produto indisponível ou sem estoque confirmado no conteúdo extraído.'

    # 2. Check third-party marketplace seller attribution
    host = (urlsplit(url).hostname or '').lower()
    for seller_match in re.finditer(
        r'(?:vendido\s+e\s+entregue\s+por|vendido\s+por)\s*:?\s*\*?\*?([^\n|•*<\[\]()]{2,60})',
        primary_block,
        re.I,
    ):
        seller_candidate = re.split(r'\s+e\s+entregue\s+por\b', seller_match.group(1), maxsplit=1, flags=re.I)[0].strip(' .,:;-*_')
        if seller_candidate and not _is_first_party_seller(seller_candidate, host):
            return [], f'Oferta de marketplace de terceiro ({seller_candidate}); venda direta da loja não confirmada.'

    # 3. Collect all installment / monthly values to never confuse parcel with total price
    parcel_values: list[tuple[int, Decimal]] = []
    for m in re.finditer(r'\b(\d{1,2})\s*x\s*(?:de\s*)?R\$\s*([\d.]+,\d{2})', primary_block, re.I):
        count = int(m.group(1))
        val = _to_decimal_brl(m.group(2))
        if val is not None and count >= 2:
            parcel_values.append((count, val))
    for m in re.finditer(r'R\$\s*([\d.]+,\d{2})\s*(?:/\s*m[eê]s|por\s+m[eê]s|mensais|ao\s+m[eê]s)', primary_block, re.I):
        val = _to_decimal_brl(m.group(1))
        if val is not None:
            parcel_values.append((12, val))

    # 4. Extract unequivocal cash/total BRL price
    candidates: list[tuple[Decimal, str]] = []

    # Pattern A: R$ X.XXX,XX à vista / no Pix / no boleto / em 1x
    for m in re.finditer(
        r'R\$\s*([\d.]+,\d{2})\s*(?:\([^)\n]{0,35}\)\s*)?(?:à\s+vista|no\s+pix|via\s+pix|no\s+boleto|em\s+1x\b)',
        primary_block,
        re.I,
    ):
        prefix = primary_block[max(0, m.start() - 25):m.start()]
        if re.search(r'(?:\bde\s*:?|\d+\s*x\s*(?:de\s*)?|economize|desconto|frete|garantia)\s*$', prefix, re.I):
            continue
        val = _to_decimal_brl(m.group(1))
        if val is not None:
            candidates.append((val, 'Preço à vista / Pix extraído da página do produto; frete, prazo e estoque sujeitos à confirmação.'))

    # Pattern B: Preço à vista / No Pix / Por: R$ X.XXX,XX
    for m in re.finditer(
        r'(?:preço\s+à\s+vista|valor\s+à\s+vista|à\s+vista\s*(?:no\s+pix)?|no\s+pix|por)\s*:?\s*R\$\s*([\d.]+,\d{2})(?!\s*(?:/\s*m[eê]s|por\s+m[eê]s|mensal|de\s+desconto|off\b))',
        primary_block,
        re.I,
    ):
        prefix = primary_block[max(0, m.start() - 20):m.start()]
        if re.search(r'(?:\d+\s*x\s*|parcela\s+|frete\s+|entrega\s+|garantia\s+)\s*$', prefix, re.I):
            continue
        val = _to_decimal_brl(m.group(1))
        if val is not None:
            candidates.append((val, 'Preço anunciado extraído da página do produto; frete, prazo e estoque sujeitos à confirmação.'))

    # Pattern C: R$ TOTAL em até Nx de R$ PARCELA
    for m in re.finditer(
        r'R\$\s*([\d.]+,\d{2})\s*(?:à\s+vista\s*)?(?:ou\s+)?(?:em\s+at[eé]\s+|em\s+)(\d{1,2})\s*x\s*(?:de\s*)?R\$\s*([\d.]+,\d{2})',
        primary_block,
        re.I,
    ):
        total_val = _to_decimal_brl(m.group(1))
        n_inst = int(m.group(2))
        inst_val = _to_decimal_brl(m.group(3))
        if total_val is not None and inst_val is not None and n_inst >= 2:
            if total_val >= inst_val * (Decimal(n_inst) * Decimal('0.75')):
                candidates.append((total_val, 'Preço total confirmado antes do parcelamento; frete, prazo e estoque sujeitos à confirmação.'))

    # Filter out any candidate that matches or is smaller than a multi-installment parcel
    valid_candidates: list[tuple[Decimal, str]] = []
    for price_val, basis in candidates:
        if any(price_val == p_val or price_val < p_val * Decimal('1.5') for count, p_val in parcel_values if count >= 2):
            continue
        valid_candidates.append((price_val, basis))

    if not valid_candidates:
        if parcel_values:
            return [], 'Apenas valores parcelados identificados; preço total à vista não confirmado com segurança.'
        return [], 'Preço total em BRL não encontrado de forma inequívoca no conteúdo extraído.'

    chosen_price, chosen_basis = valid_candidates[0]
    method = f'tavily_extract/{extract_depth}'
    return [
        {
            '@type': 'Product',
            'name': title,
            'url': url,
            'offers': {
                '@type': 'Offer',
                'price': str(chosen_price),
                'priceCurrency': 'BRL',
                'availability': 'Unknown',
                'url': url,
            },
            '_extraction_method': method,
            '_price_basis': chosen_basis,
        }
    ], None


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

    if (urlsplit(url).hostname or '').lower() in {'amazon.com.br', 'www.amazon.com.br'} and re.search(r'/(?:dp|gp/product)/[A-Z0-9]{10}', urlsplit(url).path):
        title = soup.select_one('#productTitle')
        avail_el = soup.select_one('#availability')
        avail_text = avail_el.get_text(' ', strip=True) if avail_el else ''
        in_stock = bool(re.search(r'em estoque|dispon[ií]vel', avail_text, re.I)) and not bool(re.search(r'indispon[ií]vel|esgotado|fora de estoque', avail_text, re.I))
        price_el = soup.select_one('#corePriceDisplay_desktop_feature_div .priceToPay, #corePrice_feature_div .apex-pricetopay-value')
        if title is not None and in_stock and price_el is not None:
            whole = price_el.select_one('.a-price-whole')
            fraction = price_el.select_one('.a-price-fraction')
            if whole is not None and fraction is not None:
                raw_whole = re.sub(r'[^\d]', '', whole.get_text(strip=True))
                raw_frac = re.sub(r'[^\d]', '', fraction.get_text(strip=True))
                if raw_whole and len(raw_frac) == 2:
                    nodes.append({'@type': 'Product', 'name': title.get_text(' ', strip=True), 'url': url, 'offers': {'@type': 'Offer', 'price': f'{raw_whole}.{raw_frac}', 'priceCurrency': 'BRL', 'availability': 'InStock', 'url': url}, '_extraction_method': 'merchant_html/amazon.priceToPay'})
    return nodes
