import asyncio
import time
from collections import defaultdict
from decimal import Decimal
from urllib.parse import urlsplit

import requests
from requests.adapters import HTTPAdapter
from anyio import to_thread
from starlette.concurrency import run_in_threadpool

from .config import settings
from .scraper_tools import MarketScraper, ProductOffer, Reputation, ScrapingError, canonical_url, normalize, validate_public_url, MAX_PAGE_BYTES
from .web_policy import AccessPolicy


class PinnedAdapter(HTTPAdapter):
    def __init__(self, address, hostname):
        self.address, self.hostname = address, hostname
        super().__init__(max_retries=0)

    def get_connection_with_tls_context(self, request, verify, proxies=None, cert=None):
        hosts, options = self.build_connection_pool_key_attributes(request, verify, cert)
        if hosts['host'] != self.hostname:
            raise ScrapingError('Destino HTTP não corresponde ao domínio validado.')
        hosts['host'] = self.address
        if hosts['scheme'] == 'https':
            options.update(server_hostname=self.hostname, assert_hostname=self.hostname)
        return self.poolmanager.connection_from_host(**hosts, pool_kwargs=options)


def read_page(url: str, address: str) -> tuple[int, dict, str]:
    deadline = time.monotonic() + settings.scrape_timeout_seconds + 5
    try:
        parsed = urlsplit(url)
        with requests.Session() as session:
            session.trust_env = False
            session.mount(parsed.scheme + '://', PinnedAdapter(address, parsed.hostname))
            response = session.get(url, timeout=(5, settings.scrape_timeout_seconds), allow_redirects=False, stream=True, headers={"User-Agent": "NexoProcurement/1.0", "Host": parsed.netloc, "Accept-Language": "pt-BR,pt;q=0.9"})
            if parsed.path == '/robots.txt' and response.status_code in {404, 410}:
                return response.status_code, dict(response.headers), ''
            if 300 <= response.status_code < 400:
                return response.status_code, dict(response.headers), ""
            if response.status_code in {202, 401, 403, 429}:
                if response.headers.get('cf-mitigated') == 'challenge':
                    raise ScrapingError('Proteção antibot do site exige verificação humana (HTTP 403); fonte não acessível por coleta automática.')
                if response.status_code == 429:
                    raise ScrapingError('Limite de consultas imposto pelo site (HTTP 429); tente novamente após o intervalo indicado pelo fornecedor.')
                raise ScrapingError(f"Consulta bloqueada pelo site (HTTP {response.status_code}).")
            response.raise_for_status()
            if not any(t in response.headers.get('content-type', '') for t in ('text/html', 'application/xhtml+xml', 'application/json', 'text/plain')):
                raise ScrapingError('Formato de página não suportado.')
            chunks = bytearray()
            for chunk in response.iter_content(65536):
                if time.monotonic() > deadline:
                    raise ScrapingError('Prazo de leitura da página excedido.')
                chunks.extend(chunk)
                if len(chunks) > MAX_PAGE_BYTES:
                    raise ScrapingError('Página excedeu o limite de leitura.')
            return response.status_code, dict(response.headers), chunks.decode(response.encoding or 'utf-8', errors='replace')
    except requests.RequestException:
        raise ScrapingError(f'Falha de conexão ao consultar {urlsplit(url).hostname}.') from None


class RealMarketScraper(MarketScraper):
    def __init__(self):
        super().__init__()
        self.policy = AccessPolicy(self.raw_fetch)

    async def fetch(self, url: str) -> tuple[str, str]:
        await self.policy.allow(url)
        status, headers, html, final = await self.raw_fetch(url, check_redirect=True)
        return html, final

    async def raw_fetch(self, url: str, check_redirect=False):
        current = canonical_url(url)
        for _ in range(5):
            address = await validate_public_url(current)
            await self.policy.pace(current)
            async with self.semaphore:
                status, headers, html = await asyncio.wait_for(to_thread.run_sync(read_page, current, address, abandon_on_cancel=True), settings.scrape_timeout_seconds + 5)
            if 300 <= status < 400:
                current = canonical_url(headers.get('Location', ''), current)
                if check_redirect:
                    await self.policy.allow(current)
            else:
                return status, headers, html, current
        raise ScrapingError('Limite de redirecionamentos excedido.')


async def search_market(item: str, progress=None):
    async with RealMarketScraper() as scraper:
        scraper.on_progress = progress
        return await scraper.discover(item)


async def check_reputation(supplier_name: str, supplier: ProductOffer) -> Reputation:
    if supplier_name != supplier.supplier_name:
        raise ValueError('Nome do fornecedor não corresponde à fonte.')
    async with RealMarketScraper() as scraper:
        return await scraper.reputation(supplier)


def comparable_market(products: list[ProductOffer]) -> tuple[list[ProductOffer], Decimal | None, Decimal | None]:
    groups = defaultdict(dict)
    for product in products:
        identity = ('gtin', product.gtin) if product.gtin else ('title', *sorted(set(normalize(product.product_name).split()) - {'de', 'da', 'do', 'com', 'e', 'para'}))
        old = groups[identity].get(product.supplier_domain)
        if old is None or product.price < old.price:
            groups[identity][product.supplier_domain] = product
    if not groups:
        return [], None, None
    group = min(groups.values(), key=lambda g: (-len(g), sum(p.price for p in g.values()) / len(g)))
    products = sorted(group.values(), key=lambda p: (p.price, p.supplier_domain))
    if len(products) < 3:
        return products, None, None
    average = (sum(p.price for p in products) / len(products)).quantize(Decimal('0.01'))
    return products, average, max(Decimal('0.01'), (average * Decimal('0.85')).quantize(Decimal('0.01')))
