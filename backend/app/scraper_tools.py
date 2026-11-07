import asyncio
import base64
import hashlib
import ipaddress
import json
import re
import socket
import unicodedata
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from typing import Literal
from urllib.parse import parse_qs, quote, unquote, urlencode, urljoin, urlsplit, urlunsplit

import httpx
import tldextract
from bs4 import BeautifulSoup
from pydantic import BaseModel, Field

from .config import settings
from .commercial import AdditionalCost
from .search_provider import SearchProviderError, tavily_results, tavily_search
from .product_parsers import html_product_nodes


extract_domain = tldextract.TLDExtract(suffix_list_urls=(), cache_dir=None)
MAX_PAGE_BYTES = 6_000_000


def timestamp() -> str:
    return datetime.now(timezone.utc).isoformat()


class ScrapingError(Exception):
    pass


class ProductOffer(BaseModel):
    additional_costs: list[AdditionalCost] | None = None
    supplier_name: str
    supplier_domain: str
    supplier_website: str
    product_name: str
    product_url: str
    price: Decimal = Field(gt=0, max_digits=12, decimal_places=2)
    shipping_fee: Decimal | None = Field(default=None, ge=0, max_digits=12, decimal_places=2)
    shipping_scope: str | None = None
    gtin: str | None = None
    currency: Literal["BRL"] = "BRL"
    availability: str
    price_basis: str = "Preço anunciado; estoque para a quantidade solicitada, frete e condições sujeitos à confirmação."
    observed_at: str
    extraction_method: str
    evidence_sha256: str


class Reputation(BaseModel):
    supplier_domain: str
    company_name: str | None = None
    url: str | None = None
    score: Decimal | None = Field(default=None, ge=0, le=10)
    label: str = "Não verificada"
    period: str | None = None
    checked_at: str
    verified: bool = False
    approved: bool = False
    reason: str
    evidence_sha256: str | None = None


class SearchCandidate(BaseModel):
    url: str
    title: str
    description: str = ''
    kind: Literal['product', 'category', 'unknown'] = 'unknown'
    price: Decimal | None = None
    product_name: str | None = None
    error: str | None = None


def equivalent_product(left: str, right: str) -> bool:
    ignored = {'de', 'da', 'do', 'com', 'e', 'para'}
    return set(normalize(left).split()) - ignored == set(normalize(right).split()) - ignored


class Discovery(BaseModel):
    candidates: list[SearchCandidate] = Field(default_factory=list)
    blocked_sites: int = 0
    products: list[ProductOffer] = Field(default_factory=list)
    errors: list[str] = Field(default_factory=list)
    searched_at: str
    query: str


def domain(url: str) -> str:
    extracted = extract_domain(urlsplit(url).hostname or "")
    return extracted.top_domain_under_public_suffix


def valid_gtin(value) -> str | None:
    value = str(value or '').strip()
    if not value.isdigit() or len(value) not in {8, 12, 13, 14}:
        return None
    total = sum(int(digit) * (3 if index % 2 == 0 else 1) for index, digit in enumerate(reversed(value[:-1])))
    return value.zfill(14) if (10 - total % 10) % 10 == int(value[-1]) else None


def normalize(text: str) -> str:
    return " ".join(re.findall(r"[a-z0-9]+", unicodedata.normalize("NFKD", text.casefold()).encode("ascii", "ignore").decode()))


_TOKEN_SYNONYMS = {
    "televisao": "tv",
    "televisor": "tv",
    "smarttv": "tv",
    "laptop": "notebook",
    "refrigerador": "geladeira",
}
_UNIT_SUFFIX_RE = re.compile(r"^(\d+)(mhz|ghz|gb|tb|mb|hz|pol|w|v|kg|ml)$")
_MODEL_PREFIX_DIGITS_RE = re.compile(r"^(\d{2,4})[a-z][a-z0-9]*$")


def _canonical_tokens(text: str, *, expand_model_digits: bool = False) -> set[str]:
    raw = normalize(text).split()
    out: set[str] = set()
    for token in raw:
        mapped = _TOKEN_SYNONYMS.get(token, token)
        out.add(mapped)
        unit_match = _UNIT_SUFFIX_RE.match(mapped)
        if unit_match:
            out.add(unit_match.group(1))
            out.add(unit_match.group(2))
        elif expand_model_digits:
            model_match = _MODEL_PREFIX_DIGITS_RE.match(mapped)
            if model_match:
                out.add(model_match.group(1))
    return out


def _token_matches(term: str, found: set[str]) -> bool:
    if term in found:
        return True
    if len(term) >= 5 and term.isalpha():
        from difflib import SequenceMatcher
        return any(
            len(candidate) >= 5 and candidate.isalpha() and SequenceMatcher(None, term, candidate).ratio() >= 0.83
            for candidate in found
        )
    return False


def same_product(query: str, title: str) -> bool:
    ignored = {"de", "da", "do", "das", "dos", "com", "para", "e", "um", "uma", "o", "a", "comprar", "preco", "polegadas", "polegada", "pol", "unidades", "unidade", "un"}
    terms = _canonical_tokens(query, expand_model_digits=False) - ignored
    found = _canonical_tokens(title, expand_model_digits=True)
    if not terms:
        return False
    identifiers = {term for term in terms if any(char.isdigit() for char in term)}
    if not identifiers <= found:
        return False
    accessories = {"capa", "suporte", "pelicula", "case", "adaptador", "carregador", "usado", "recondicionado"}
    if (found & accessories) - terms:
        return False
    bundles = {'combo', 'combos', 'kit', 'conjunto'}
    if found & bundles and not (terms & bundles or {'teclado', 'mouse'} <= terms):
        return False
    matched = sum(1 for term in terms if _token_matches(term, found))
    return matched / len(terms) >= 0.8


def canonical_url(value: str, base: str = "") -> str:
    parts = urlsplit(urljoin(base, value.strip()))
    if parts.scheme not in {"https", "http"} or not parts.hostname or parts.username or parts.password:
        raise ScrapingError("URL de origem inválida.")
    if parts.port not in {None, 80, 443}:
        raise ScrapingError("Porta de origem não permitida.")
    return urlunsplit((parts.scheme, parts.netloc, parts.path or "/", parts.query, ""))


async def validate_public_url(url: str) -> str:
    parts = urlsplit(canonical_url(url))
    try:
        addresses = await asyncio.wait_for(asyncio.get_running_loop().getaddrinfo(parts.hostname, parts.port or (443 if parts.scheme == "https" else 80), type=socket.SOCK_STREAM), 5)
    except (OSError, TimeoutError) as exc:
        raise ScrapingError("Não foi possível resolver o domínio público.") from exc
    if not addresses or any(not ipaddress.ip_address(address[4][0]).is_global for address in addresses):
        raise ScrapingError("Endereços locais e privados não são permitidos.")
    return sorted({address[4][0] for address in addresses}, key=lambda value: (':' in value, value))[0]


def json_nodes(value):
    if isinstance(value, dict):
        yield value
        for child in value.values():
            yield from json_nodes(child)
    elif isinstance(value, list):
        for child in value:
            yield from json_nodes(child)


def schema_type(node: dict, name: str) -> bool:
    types = node.get("@type", [])
    return any(isinstance(value, str) and value.rstrip('/').rsplit('/', 1)[-1] == name for value in (types if isinstance(types, list) else [types]))


def parse_price(value) -> Decimal:
    if isinstance(value, bool) or not re.fullmatch(r"\d{1,10}(?:\.\d{1,2})?", str(value).strip()):
        raise ValueError("Preço estruturado inválido ou ambíguo.")
    price = Decimal(str(value)).quantize(Decimal("0.01"))
    if not price.is_finite() or price <= 0:
        raise ValueError("Preço deve ser positivo.")
    return price


def unconditional_shipping(offer: dict) -> Decimal | None:
    details = offer.get('shippingDetails')
    rows = details if isinstance(details, list) else [details]
    if len(rows) != 1 or not isinstance(rows[0], dict):
        return None
    detail = rows[0]
    if set(detail) - {'@type', '@id', 'shippingRate', 'shippingDestination', 'deliveryTime'}:
        return None
    destination = detail.get('shippingDestination')
    if not isinstance(destination, dict) or destination.get('addressCountry') != 'BR':
        return None
    if set(destination) - {'@type', 'addressCountry'}:
        return None
    rate = detail.get('shippingRate')
    if not isinstance(rate, dict) or rate.get('currency') != 'BRL' or set(rate) - {'@type', 'value', 'currency'}:
        return None
    try:
        amount = Decimal(str(rate.get('value')))
        if amount.is_finite() and 0 <= amount <= Decimal('9999999999.99') and amount == amount.quantize(Decimal('0.01')):
            return amount.quantize(Decimal('0.01'))
    except InvalidOperation:
        pass
    return None


def parse_product(html: str, url: str, query: str) -> ProductOffer:
    soup = BeautifulSoup(html, "html.parser")
    nodes = []
    for script in soup.select('script[type="application/ld+json"]'):
        try:
            nodes.extend(json_nodes(json.loads(script.get_text())))
        except (ValueError, RecursionError):
            continue
    definitions = {node['@id']: node for node in nodes if isinstance(node.get('@id'), str) and len(node) > 1}
    html_nodes = html_product_nodes(soup, url)
    unavailable_names = set()
    for node in nodes:
        if not schema_type(node, 'Product'):
            continue
        offers = node.get('offers', [])
        offers = [offers] if isinstance(offers, dict) else offers
        if not isinstance(offers, list):
            continue
        for raw in offers:
            if not isinstance(raw, dict):
                continue
            offer = {**definitions.get(raw.get('@id'), {}), **raw}
            if str(offer.get('availability', '')).rsplit('/', 1)[-1] in {'OutOfStock', 'SoldOut', 'Discontinued', 'PreOrder', 'PreSale'} or (offer.get('priceValidUntil') and str(offer['priceValidUntil'])[:10] < datetime.now(timezone.utc).date().isoformat()):
                unavailable_names.add(normalize(str(node.get('name', ''))))
    nodes.extend(node for node in html_nodes if normalize(node['name']) not in unavailable_names)
    products = [node for node in nodes if schema_type(node, "Product") and isinstance(node.get("name"), str) and same_product(query, node["name"])]
    for product in products:
        offers = product.get("offers", [])
        if isinstance(offers, dict):
            offers = [offers]
        for offer in offers if isinstance(offers, list) else []:
            if not isinstance(offer, dict):
                continue
            offer = {**definitions.get(offer.get('@id'), {}), **offer}
            specification = offer.get('priceSpecification')
            if offer.get('price') is None and isinstance(specification, dict) and schema_type(specification, 'UnitPriceSpecification') and not specification.get('billingDuration') and not specification.get('priceType'):
                offer = {**specification, **offer, 'price': specification.get('price'), 'priceCurrency': offer.get('priceCurrency') or specification.get('priceCurrency')}
            if offer.get("priceCurrency") != "BRL":
                continue
            if schema_type(offer, "AggregateOffer"):
                continue
            availability = str(offer.get("availability", ""))
            if normalize(availability.rsplit('/', 1)[-1]) in {'outofstock', 'out of stock', 'oos', 'soldout', 'sold out', 'discontinued', 'preorder', 'presale', 'indisponivel', 'esgotado'}:
                continue
            expires = str(offer.get("priceValidUntil", ""))
            if expires and expires[:10] < datetime.now(timezone.utc).date().isoformat():
                continue
            try:
                price = parse_price(offer.get("price"))
                main_page = product.get("mainEntityOfPage")
                declared_url = offer.get("url") or product.get("url") or (main_page.get("@id") if isinstance(main_page, dict) else main_page)
                if not declared_url:
                    heading = soup.find("h1")
                    if heading is None or not same_product(product["name"], heading.get_text(" ", strip=True)):
                        continue
                product_url = canonical_url(str(declared_url or url), url)
            except (ValueError, InvalidOperation, ScrapingError):
                continue
            if domain(product_url) != domain(url):
                continue
            seller = offer.get("seller") or product.get("seller") or {}
            if isinstance(seller, list):
                seller = seller[0] if len(seller) == 1 else {}
            site_name = soup.select_one('meta[property="og:site_name"]')
            organization = next((node for node in nodes if schema_type(node, "Organization") and node.get("name") and domain(str(node.get("url", ""))) == domain(url)), {})
            supplier = seller.get("name") if isinstance(seller, dict) else None
            seller_url = seller.get("url") if isinstance(seller, dict) else None
            if supplier and seller_url and domain(canonical_url(seller_url, url)) != domain(url):
                continue
            if not supplier:
                supplier = organization.get("name") or (site_name.get("content") if site_name else None)
            if not supplier:
                supplier = domain(url)
            if not isinstance(supplier, str) or not supplier.strip():
                continue
            if normalize(supplier) == normalize(product['name']):
                supplier = domain(url)
                if not supplier:
                    continue
            method = product.get('_extraction_method', 'schema.org/Product.offers')
            evidence = json.dumps({"product": product["name"], "offer": offer, "supplier": supplier, 'url': product_url, 'method': method}, ensure_ascii=False, sort_keys=True)
            shipping = unconditional_shipping(offer)
            return ProductOffer(
                supplier_name=supplier.strip(), supplier_domain=domain(url),
                supplier_website=f"{urlsplit(url).scheme}://{urlsplit(url).netloc}",
                product_name=product["name"], product_url=product_url, price=price,
                shipping_fee=shipping, shipping_scope='BR' if shipping is not None else None,
                gtin=next((v for field in ("gtin14", "gtin13", "gtin12", "gtin8", "gtin") if (v := valid_gtin(product.get(field)))), None),
                availability=availability.rsplit("/", 1)[-1] or "Unknown", observed_at=timestamp(),
                price_basis=product.get('_price_basis', 'Preço anunciado; frete, estoque e condições sujeitos à confirmação.'),
                extraction_method=method, evidence_sha256=hashlib.sha256(evidence.encode()).hexdigest(),
            )
    raise ScrapingError("Página sem produto correspondente e preço BRL inequívoco em dados estruturados, ou oferta indisponível.")


def search_result_url(href: str, base: str) -> str | None:
    url = urljoin(base, href)
    parts = urlsplit(url)
    params = parse_qs(parts.query)
    if domain(url) == "bing.com" and params.get("u"):
        value = params["u"][0]
        if value.startswith("a1"):
            try:
                url = base64.urlsafe_b64decode(value[2:] + "=" * (-len(value[2:]) % 4)).decode()
            except (ValueError, UnicodeError):
                return None
    elif domain(url) == "duckduckgo.com" and params.get("uddg"):
        url = params["uddg"][0]
    elif domain(url) == "google.com" and parts.path == "/url":
        url = (params.get("q") or params.get("url") or [""])[0]
    elif domain(url) == "yahoo.com" and "/RU=" in parts.path:
        url = unquote(parts.path.split("/RU=", 1)[1].split("/RK=", 1)[0])
    try:
        result = canonical_url(url)
    except (ScrapingError, ValueError):
        return None
    if domain(result) in {"google.com", "bing.com", "yahoo.com", "duckduckgo.com"}:
        return None
    return result


def product_links(html: str, base: str, item: str) -> list[str]:
    soup = BeautifulSoup(html, "html.parser")
    candidates = []
    for anchor in soup.select("a[href]"):
        title = " ".join([anchor.get_text(" ", strip=True), str(anchor.get("title", "")), *(str(image.get("alt", "")) for image in anchor.select("img[alt]"))])
        if same_product(item, title):
            try:
                url = canonical_url(anchor["href"], base)
                if domain(url) == domain(base) and url != base:
                    candidates.append(url)
            except (ValueError, ScrapingError):
                continue
    page_title = ' '.join(t.get_text(' ', strip=True) for t in soup.select('title,h1'))
    for script in soup.select('script[type="application/ld+json"]'):
        try:
            for node in json_nodes(json.loads(script.get_text())):
                if not schema_type(node, 'Product') and not (schema_type(node, 'ListItem') and same_product(item, page_title)):
                    continue
                raw = node.get('url')
                if not isinstance(raw, str) or (node.get('name') and not same_product(item, str(node['name']))):
                    continue
                link = canonical_url(raw, base)
                if domain(link) == domain(base) and link != base:
                    candidates.append(link)
        except (ValueError, RecursionError, ScrapingError):
            continue
    return sorted(dict.fromkeys(candidates), key=product_url_rank)[:6]


def product_url_rank(url: str):
    path = urlsplit(url).path.lower()
    product = bool(re.search(r'/(?:prod|produto|product|products|dp|p)/|/p$|\.html$', path))
    category = bool(re.search(r'/(?:busca|search|category|categorias|c|collections)/', path))
    return (0 if product else 2 if category or path == '/' else 1, len(path))


def merchant_search_url(html: str, base: str, item: str) -> str | None:
    soup = BeautifulSoup(html, "html.parser")
    for script in soup.select('script[type="application/ld+json"]'):
        try:
            for node in json_nodes(json.loads(script.get_text())):
                if not schema_type(node, "SearchAction"):
                    continue
                target = node.get("target")
                template = target.get("urlTemplate") if isinstance(target, dict) else target
                if isinstance(template, str) and re.search(r"\{[a-zA-Z_]+\}", template):
                    url = canonical_url(re.sub(r"\{[a-zA-Z_]+\}", quote(item, safe=""), template), base)
                    if domain(url) == domain(base):
                        return url
        except (ValueError, RecursionError, ScrapingError):
            continue
    for form in soup.select("form[action]"):
        if form.get("method", "get").lower() != "get":
            continue
        field = form.select_one('input[type="search"][name], input[name="q"], input[name="query"], input[name="search"], input[name="s"]')
        if field:
            try:
                action = canonical_url(form["action"], base)
                if domain(action) == domain(base):
                    return action + ("&" if "?" in action else "?") + urlencode({field["name"]: item})
            except (ValueError, ScrapingError):
                continue
    return None


class MarketScraper:
    def __init__(self):
        self.client = httpx.AsyncClient(timeout=httpx.Timeout(settings.scrape_timeout_seconds), follow_redirects=False, limits=httpx.Limits(max_connections=6), headers={"User-Agent": "Mozilla/5.0 (compatible; NexoProcurement/1.0; market-research)", "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.5"})
        self.semaphore = asyncio.Semaphore(4)
        self.on_progress = None
        self.search_candidates = {}

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        await self.client.aclose()

    async def fetch(self, url: str) -> tuple[str, str]:
        current = canonical_url(url)
        async with self.semaphore, asyncio.timeout(settings.scrape_timeout_seconds + 6):
            for _ in range(5):
                await validate_public_url(current)
                try:
                    async with self.client.stream("GET", current) as response:
                        if response.is_redirect:
                            current = canonical_url(response.headers.get("location", ""), current)
                            continue
                        if response.status_code in {202, 401, 403, 429}:
                            raise ScrapingError(f"Consulta bloqueada pelo site (HTTP {response.status_code}).")
                        response.raise_for_status()
                        if not any(mime in response.headers.get("content-type", "") for mime in ("text/html", "application/xhtml+xml", "application/json")):
                            raise ScrapingError("Formato de página não suportado.")
                        data = bytearray()
                        async for chunk in response.aiter_bytes():
                            data.extend(chunk)
                            if len(data) > MAX_PAGE_BYTES:
                                raise ScrapingError("Página excedeu o limite de leitura.")
                        text = data.decode(response.encoding or "utf-8", errors="replace")
                        if re.search(r"<title>\s*(Just a moment|Access denied|Attention Required)", text, re.I):
                            raise ScrapingError("Página exige verificação humana.")
                        return text, str(response.url)
                except httpx.HTTPError as exc:
                    raise ScrapingError(f"Falha HTTP ao consultar {urlsplit(current).hostname} ({type(exc).__name__}).") from exc
        raise ScrapingError("Limite de redirecionamentos excedido.")

    async def search(self, query: str) -> list[str]:
        try:
            results = await tavily_results(query)
            if results is not None:
                urls = []
                for result in results:
                    try:
                        url = canonical_url(result['url'])
                        urls.append(url)
                        self.search_candidates[url] = SearchCandidate(url=url, title=result['title'], description=result['description'])
                    except (ScrapingError, ValueError):
                        continue
                return list(dict.fromkeys(urls))
        except SearchProviderError as exc:
            raise ScrapingError(str(exc)) from None
        if settings.brave_search_api_key:
            try:
                response = await self.client.get("https://api.search.brave.com/res/v1/web/search", params={"q": query, "count": 20, "country": "BR", "search_lang": "pt-br"}, headers={"X-Subscription-Token": settings.brave_search_api_key.get_secret_value()})
                response.raise_for_status()
                return list(dict.fromkeys(canonical_url(row["url"]) for row in response.json().get("web", {}).get("results", []) if row.get("url")))
            except (httpx.HTTPError, ValueError, KeyError) as exc:
                raise ScrapingError("O provedor de busca configurado não respondeu com resultados válidos.") from exc
        engines = [
            ("https://www.bing.com/search?" + urlencode({"q": query, "cc": "br", "setlang": "pt-br", "count": 30}), "li.b_algo h2 a"),
            ("https://search.yahoo.com/search?" + urlencode({"p": query}), "h3 a"),
            ("https://html.duckduckgo.com/html/?" + urlencode({"q": query}), "a.result__a"),
        ]
        async def collect(url, selector):
            try:
                html, final = await self.fetch(url)
                return [result for anchor in BeautifulSoup(html, "html.parser").select(selector) if (result := search_result_url(anchor.get("href", ""), final))]
            except (ScrapingError, ValueError):
                return []
        results = await asyncio.gather(*(collect(*engine) for engine in engines))
        urls = list(dict.fromkeys(url for group in results for url in group))
        if not urls:
            raise ScrapingError("Buscadores indisponíveis ou bloqueados. Nenhum resultado foi inventado. Configure um provedor de busca ou tente novamente mais tarde.")
        return urls[:40]

    async def discover(self, item: str) -> Discovery:
        result = Discovery(query=item, searched_at=timestamp())
        deadline = asyncio.get_running_loop().time() + settings.discovery_timeout_seconds
        alt_item = re.sub(r"\s+", " ", re.sub(r"\bpolegadas?\b", '"', re.sub(r"\b(?:televisão|televisao|televisor)\b", "Smart TV", item, flags=re.I), flags=re.I)).strip()
        second_query = f'{alt_item} comprar preço à vista' if alt_item.lower() != item.lower() else f'"{item}" comprar preço à vista'
        queries = [f'{item} preço comprar Brasil', second_query]
        urls = []
        for query in queries:
            try:
                remaining = max(0.1, deadline - asyncio.get_running_loop().time())
                urls.extend(await asyncio.wait_for(self.search(query), remaining))
            except (ScrapingError, TimeoutError) as exc:
                result.errors.append(str(exc) or "Tempo limite da pesquisa atingido.")
                if asyncio.get_running_loop().time() >= deadline:
                    break
        non_merchant_domains = {
            "youtube.com", "instagram.com", "facebook.com", "tiktok.com", "twitter.com", "x.com",
            "reddit.com", "wikipedia.org", "tudocelular.com", "tecnoblog.net", "techtudo.com.br",
            "canaltech.com.br", "uol.com.br", "globo.com", "olhardigital.com.br", "adrenaline.com.br",
            "promobit.com.br", "pelando.com.br", "reclameaqui.com.br", "tavily.com", "buscape.com.br", "zoom.com.br",
        }
        urls = [url for url in sorted(dict.fromkeys(urls), key=product_url_rank) if domain(url) not in non_merchant_domains][:60]
        result.candidates = [self.search_candidates.get(url, SearchCandidate(url=url, title=url)) for url in urls]
        if self.on_progress:
            await self.on_progress(result)
        async def product(url):
            try:
                html, final = await self.fetch(url)
                try:
                    found = parse_product(html, final, item)
                    if urlsplit(found.product_url).path != urlsplit(final).path:
                        page, destination = await self.fetch(found.product_url)
                        return parse_product(page, destination, item)
                    return found
                except ScrapingError as original:
                    links = product_links(html, final, item)
                    if not links and (search := merchant_search_url(html, final, item)):
                        html, final = await self.fetch(search)
                        links = product_links(html, final, item)
                    failures = []
                    for link in links[:4]:
                        try:
                            page, destination = await self.fetch(link)
                            return parse_product(page, destination, item)
                        except (ScrapingError, TimeoutError) as exc:
                            failures.append(str(exc) or 'Tempo limite ao acessar produto.')
                            continue
                    raise ScrapingError(str(original) + (f' {len(links[:4])} links de produto verificados: {failures[-1]}' if failures else ' Nenhum link de produto acessível nesta página.'))
            except (ScrapingError, ValueError, InvalidOperation, TimeoutError) as exc:
                return f"{urlsplit(url).hostname}: {exc or 'Tempo limite de acesso à página.'}"

        by_supplier = {}
        candidates = {row.url: row for row in result.candidates}

        def save(row, url):
            if isinstance(row, ProductOffer):
                previous = by_supplier.get(row.supplier_domain)
                if previous is None or row.price < previous.price:
                    by_supplier[row.supplier_domain] = row
                candidates[row.product_url] = SearchCandidate(url=row.product_url, title=row.product_name, kind='product', product_name=row.product_name, price=row.price)
            else:
                result.errors.append(row)
                if url in candidates:
                    candidates[url].error = row
            result.products = sorted(by_supplier.values(), key=lambda p: p.price)[:30]
            result.candidates = list(candidates.values())[:60]

        async def collect(batch):
            async def inspect(url):
                return url, await product(url)
            tasks = [asyncio.create_task(inspect(url)) for url in batch]
            try:
                for ready in asyncio.as_completed(tasks, timeout=max(0.1, deadline - asyncio.get_running_loop().time())):
                    url, row = await ready
                    save(row, url)
                    if self.on_progress and isinstance(row, ProductOffer):
                        await self.on_progress(result.model_copy(deep=True))
            except TimeoutError:
                result.errors.append('Prazo de coleta atingido; resultados já verificados foram preservados.')
            finally:
                for task in tasks:
                    if not task.done():
                        task.cancel()
                await asyncio.gather(*tasks, return_exceptions=True)

        await collect(urls)
        if len(result.products) < 3 and deadline - asyncio.get_running_loop().time() > 15:
            try:
                extra = await asyncio.wait_for(self.search(f'{item} "R$" "comprar" -suporte -manual'), min(25, deadline - asyncio.get_running_loop().time()))
                extra = [url for url in extra if url not in candidates][:20]
                for url in extra:
                    candidates[url] = self.search_candidates.get(url, SearchCandidate(url=url, title=url))
                await collect(sorted(extra, key=product_url_rank))
            except (ScrapingError, TimeoutError) as exc:
                result.errors.append(str(exc) or 'Busca adicional excedeu o prazo.')
        result.candidates = list(candidates.values())[:60]
        result.blocked_sites = sum('bloquead' in error.lower() or 'verificação humana' in error for error in result.errors)
        result.errors = result.errors[:40]
        return result

    async def explore(self, candidate: SearchCandidate, query: str) -> list[SearchCandidate]:
        html, final = await self.fetch(candidate.url)
        try:
            offer = parse_product(html, final, query)
            if urlsplit(offer.product_url).path != urlsplit(final).path:
                html, final = await self.fetch(offer.product_url)
                offer = parse_product(html, final, query)
            return [SearchCandidate(url=offer.product_url, title=offer.product_name, product_name=offer.product_name, kind='product', price=offer.price)]
        except ScrapingError:
            pass
        soup = BeautifulSoup(html, 'html.parser')
        heading = soup.find('h1')
        nodes = []
        for script in soup.select('script[type="application/ld+json"]'):
            try:
                nodes.extend(json_nodes(json.loads(script.get_text())))
            except (ValueError, RecursionError):
                continue
        identities = [node for node in nodes if schema_type(node, 'Product') and isinstance(node.get('name'), str) and same_product(query, node['name']) and heading and equivalent_product(node['name'], heading.get_text(' ', strip=True))]
        if len(identities) == 1:
            name = identities[0]['name']
            return [SearchCandidate(url=final, title=name, product_name=name, kind='product')]
        links = product_links(html, final, query)
        if not links and (search := merchant_search_url(html, final, query)):
            html, final = await self.fetch(search)
            soup = BeautifulSoup(html, 'html.parser')
            links = product_links(html, final, query)
        rows = [candidate.model_copy(update={'kind': 'category', 'error': None})]
        for link in links:
            anchor = next((a for a in soup.select('a[href]') if urljoin(final, a.get('href', '')) == link), None)
            title = anchor.get_text(' ', strip=True) if anchor else link
            rows.append(SearchCandidate(url=link, title=title or link))
        if len(rows) == 1:
            rows[0] = candidate.model_copy(update={'error': 'Não foi possível identificar um produto nesta página. Abra o link ou escolha outro resultado.'})
        return rows

    async def reputation(self, supplier: ProductOffer) -> Reputation:
        result = Reputation(supplier_domain=supplier.supplier_domain, checked_at=timestamp(), reason="Nenhuma página de empresa verificável foi encontrada no ReclameAqui.")
        try:
            urls = await self.search(f'site:reclameaqui.com.br/empresa/ "{supplier.supplier_domain}"')
            if not urls:
                urls = await self.search(f'site:reclameaqui.com.br/empresa/ "{supplier.supplier_name}"')
        except ScrapingError as exc:
            result.reason = str(exc)
            return result
        candidates = []
        for url in urls:
            parts = urlsplit(url)
            company_path = re.fullmatch(r"(/empresa/[^/]+)(?:/(?:sobre|reputacao|lista-reclamacoes))?/?", parts.path)
            if parts.hostname in {"www.reclameaqui.com.br", "reclameaqui.com.br"} and company_path:
                candidates.append(urlunsplit(("https", "www.reclameaqui.com.br", company_path.group(1) + "/", "", "")))
        for url in list(dict.fromkeys(candidates))[:3]:
            result.url = url
            try:
                html, final = await self.fetch(url)
                return parse_reputation(html, final, supplier)
            except (ScrapingError, ValueError) as exc:
                result.reason = str(exc)
        return result


def parse_reputation(html: str, url: str, supplier: ProductOffer) -> Reputation:
    if urlsplit(url).hostname not in {"www.reclameaqui.com.br", "reclameaqui.com.br"}:
        raise ScrapingError("A reputação deve vir do domínio oficial do ReclameAqui.")
    soup = BeautifulSoup(html, "html.parser")
    text = soup.get_text(" ", strip=True)
    heading = soup.find("h1")
    company = heading.get_text(" ", strip=True) if heading else ""
    links = [anchor.get("href", "") for anchor in soup.select("a[href]")]
    matches_domain = any(domain(link) == supplier.supplier_domain for link in links if link.startswith(("http://", "https://")))
    if not matches_domain:
        raise ScrapingError("A página do ReclameAqui não vincula o domínio do fornecedor; identidade não confirmada.")
    if not company:
        raise ScrapingError("Nome da empresa não identificado no ReclameAqui.")
    pattern = r"nota\s+m[eé]dia\s+nos\s+[uú]ltimos\s+6\s+meses\s*(?:[eé:]\s*)?([0-9]{1,2}(?:[.,][0-9]{1,2})?)\s*/\s*10"
    score_match = re.search(pattern, text, re.I)
    if not score_match:
        raise ScrapingError("Nota de reputação dos últimos 6 meses não disponível; avaliações de consumidores não foram usadas como substituto.")
    score = Decimal(score_match.group(1).replace(",", "."))
    if not 0 <= score <= 10:
        raise ScrapingError("Nota de reputação fora da escala 0–10.")
    label = re.search(r"Reputa[çc][aã]o\s+(RA1000|[ÓO]tima|Boa|Regular|Ruim|N[aã]o recomendada)", text, re.I)
    period = re.search(r"Dados de\s+(\d{2}/\d{2}/\d{4})\s+at[eé]\s+(\d{2}/\d{2}/\d{4})", text, re.I)
    if period:
        start, end = (datetime.strptime(value, '%d/%m/%Y').date() for value in period.groups())
        today = datetime.now(timezone.utc).date()
        if end < start or end > today or (today - end).days > 45:
            raise ScrapingError('Período de reputação desatualizado ou inválido; aprovação pendente de dados atuais.')
    return Reputation(
        supplier_domain=supplier.supplier_domain, company_name=company, url=url, score=score,
        label=label.group(1) if label else "Nota verificada", period=period.group(0) if period else "Últimos 6 meses",
        checked_at=timestamp(), verified=True, approved=score >= 6 and not (label and re.search(r'ruim|n[aã]o recomend', label.group(1), re.I)),
        reason="Reputação verificada ≥ 6,0." if score >= 6 and not (label and re.search(r'ruim|n[aã]o recomend', label.group(1), re.I)) else "Rejeitado: nota inferior a 6,0 ou classificação desfavorável.",
        evidence_sha256=hashlib.sha256(html.encode()).hexdigest(),
    )


async def discover_market(item: str) -> Discovery:
    async with MarketScraper() as scraper:
        try:
            return await asyncio.wait_for(scraper.discover(item), settings.discovery_timeout_seconds + 5)
        except TimeoutError as exc:
            raise ScrapingError("A descoberta excedeu o prazo máximo. Tente novamente com marca e modelo específicos.") from exc
