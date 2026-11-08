"""Read the daily minimum prices published on public Buscapé product pages.

Only first-party, date/price records are accepted. No generated/backfilled prices.
"""
import asyncio
import json
import re
from dataclasses import dataclass, field
from datetime import date, datetime, timezone
from decimal import Decimal, InvalidOperation
from urllib.parse import quote_plus, urljoin, urlsplit

import httpx
from bs4 import BeautifulSoup
from pydantic import BaseModel, ConfigDict

ORIGIN = "https://www.buscape.com.br"
MAX_BYTES = 6_000_000


class HistoryCandidate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    title: str
    url: str


class HistorySource(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = "Buscapé"
    url: str
    product_name: str
    fetched_at: str
    available_start: date | None = None
    available_end: date | None = None


@dataclass
class ExternalHistory:
    history: list[dict] = field(default_factory=list)
    candidates: list[HistoryCandidate] = field(default_factory=list)
    source: HistorySource | None = None
    message: str = ""
    error: str | None = None


def product_url(value: str) -> str:
    parsed = urlsplit(value)
    if (parsed.scheme != "https" or parsed.netloc != "www.buscape.com.br"
            or parsed.query or parsed.fragment or not re.fullmatch(r"/[a-z0-9-]+/[a-z0-9-]+", parsed.path)
            or len(value) > 600):
        raise ValueError("Use o endereço de um produto em https://www.buscape.com.br/categoria/produto.")
    return value


def page_state(html: str) -> tuple[dict, dict]:
    soup = BeautifulSoup(html, "html.parser")
    script = soup.find("script", id="__NEXT_DATA__")
    if script is None:
        raise ValueError("O site não publicou os dados estruturados de histórico nesta página.")
    data = json.loads(script.get_text(), parse_float=Decimal)
    props = data.get("props", {})
    state = props.get("initialReduxState", {})
    if not isinstance(state, dict):
        raise ValueError("Formato de histórico não reconhecido.")
    return props.get("pageProps", {}), state


def parse_search(html: str) -> list[HistoryCandidate]:
    _, state = page_state(html)
    hits = state.get("hits", {}).get("hits", [])
    candidates, seen = [], set()
    for hit in hits if isinstance(hits, list) else []:
        if not isinstance(hit, dict) or hit.get("type") != "product":
            continue
        title = hit.get("name")
        try:
            url = product_url(urljoin(ORIGIN, hit.get("url", "")))
        except (ValueError, TypeError):
            continue
        if not isinstance(title, str) or not title.strip() or url in seen:
            continue
        candidates.append(HistoryCandidate(title=title[:300], url=url))
        seen.add(url)
        if len(candidates) == 10:
            break
    return candidates


def parse_product(html: str, url: str) -> ExternalHistory:
    page, state = page_state(html)
    route = page.get("route", {})
    if route.get("entityType") != "product":
        raise ValueError("Selecione uma página de produto, não uma busca ou categoria.")
    product = state.get("products", {}).get("product", {}).get("product", {})
    identifier = str(route.get("entityID", ""))
    if not identifier or str(product.get("id")) != identifier or not product.get("name"):
        raise ValueError("Não foi possível verificar o produto associado ao histórico.")
    canonical = product_url(urljoin(ORIGIN, route.get("canonical", "")))
    if canonical != product_url(url):
        raise ValueError("O site retornou um produto diferente do endereço selecionado.")
    records = state.get("priceHistory", {}).get("priceHistory", {}).get(identifier, {}).get("days", [])
    if not isinstance(records, list):
        raise ValueError("Formato de histórico não reconhecido.")
    points = {}
    for record in records[:10000]:
        if not isinstance(record, dict) or str(record.get("prodId")) != identifier:
            continue
        try:
            day = date.fromisoformat(record["date"])
            price = Decimal(str(record["price"]))
            if not price.is_finite() or price <= 0 or price >= Decimal("100000000000000") or price != price.quantize(Decimal("0.01")):
                continue
        except (KeyError, TypeError, ValueError, InvalidOperation):
            continue
        supplier = f"Buscapé · loja {record['merchantId']}" if record.get("merchantId") is not None else "Buscapé · loja não identificada"
        point = dict(date=day, price=price.quantize(Decimal("0.01")), supplier=supplier[:200])
        # The source describes daily minima. Duplicates cannot overweight a day.
        if day not in points or price < points[day]["price"]:
            points[day] = point
    history = [points[day] for day in sorted(points)]
    source = HistorySource(url=canonical, product_name=str(product["name"])[:300],
        fetched_at=datetime.now(timezone.utc).isoformat(),
        available_start=history[0]["date"] if history else None,
        available_end=history[-1]["date"] if history else None)
    return ExternalHistory(history=history, source=source,
        message="Histórico dos menores preços diários publicados pelo Buscapé; sem frete ou taxas.")


class BuscapeHistoryProvider:
    def __init__(self, client: httpx.AsyncClient | None = None):
        self.client = client

    async def _get(self, client: httpx.AsyncClient, url: str) -> str:
        # Fixed host, explicit redirect validation and a size limit prevent SSRF
        # and do not bypass login, challenges or access-denied responses.
        for _ in range(3):
            async with client.stream("GET", url, follow_redirects=False, timeout=8,
                                     headers={"User-Agent": "NexoProcurement/1.0", "Accept": "text/html"}) as response:
                if response.status_code in (301, 302, 303, 307, 308):
                    url = product_url(urljoin(url, response.headers.get("location", "")))
                    continue
                response.raise_for_status()
                content = bytearray()
                async for chunk in response.aiter_bytes():
                    content.extend(chunk)
                    if len(content) > MAX_BYTES:
                        raise ValueError("A página excedeu o limite de leitura.")
                return content.decode("utf-8")
        raise ValueError("O site retornou redirecionamentos demais.")

    async def fetch(self, item: str, url: str | None = None) -> ExternalHistory:
        async def read(client: httpx.AsyncClient):
            if url:
                return parse_product(await self._get(client, product_url(url)), url)
            search = f"{ORIGIN}/busca/{quote_plus(item)}"
            candidates = parse_search(await self._get(client, search))
            return ExternalHistory(candidates=candidates, message=(
                "Selecione o produto exato encontrado no Buscapé para carregar o histórico. Confira modelo, geração e capacidade."
                if candidates else "O Buscapé não encontrou produtos com histórico para esta busca."))
        try:
            if self.client:
                return await asyncio.wait_for(read(self.client), timeout=15)
            async with httpx.AsyncClient() as client:
                return await asyncio.wait_for(read(client), timeout=15)
        except (httpx.HTTPError, TimeoutError, ValueError, KeyError, TypeError, AttributeError):
            return ExternalHistory(message="O histórico externo não está disponível agora. Tente atualizar ou confira o produto no Buscapé. Nenhum preço foi estimado.", error="external_unavailable")
