"""Internal research agent. Business records remain owned by NestJS."""
import asyncio
import hmac
import hashlib
import json
import os
import re
import sqlite3
import time
from contextlib import asynccontextmanager, closing
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any, TypedDict
from urllib.parse import urlsplit

import httpx
from fastapi import FastAPI, Header, HTTPException
from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver
from langgraph.graph import END, START, StateGraph
from pydantic import BaseModel, ConfigDict, Field, field_validator

from .agent_intelligence import ConversationTerms, conversation_intelligence, discovery_intelligence, memory_intelligence, negotiator_intelligence, parse_quote_intelligence
from .config import settings
from .scraper_tools import MarketScraper, Reputation, discover_market
from .routers.voice_webhook import router as voice_router


class TaskRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    task_id: str = Field(min_length=1, max_length=100, pattern=r"^[A-Za-z0-9_-]+$")
    request_id: str = Field(min_length=1, max_length=100)
    product: str = Field(min_length=2, max_length=300)
    specs: dict[str, str] = Field(default_factory=dict, max_length=50)
    qty: int = Field(ge=1, le=1_000_000)
    destination: str = Field(min_length=2, max_length=200)
    execution_version: int = Field(ge=1)

    @field_validator("specs")
    @classmethod
    def validate_specs(cls, value):
        if any(not key.strip() or len(key) > 100 or len(val) > 500 for key, val in value.items()):
            raise ValueError("Especificações inválidas")
        return value


class TaskState(TypedDict, total=False):
    task_id: str
    request_id: str
    product: str
    specs: dict[str, str]
    qty: int
    destination: str
    execution_version: int
    quote_text: str
    parsed_quote: dict
    query: str
    discovery: dict
    raw_quotes: list[dict]
    quotes: list[dict]
    reputations: list[dict]
    status: str
    agent_notes: dict
    reputation_indications: list[dict]


class ConversationState(TypedDict):
    product: str
    qty: int
    destination: str
    message: str
    history: list[dict]
    phase: str
    terms: dict | None
    missing_fields: list[str]
    result: dict


async def conversation_turn_node(state: ConversationState):
    result = await conversation_intelligence(settings.active_llm_model, {
        "product": state["product"], "qty": state["qty"], "destination": state["destination"],
        "message": state["message"], "history": state["history"], "phase": state["phase"],
        "terms": state["terms"], "missing_fields": state["missing_fields"],
    })
    data = result.model_dump()
    terms = data.get("terms")
    previous = normalize_conversation_terms(state.get("terms"))
    proposed = normalize_conversation_terms(terms) or {}
    supplier_text = "\n".join(
        [row.get("content", "") for row in state.get("history", [])
         if isinstance(row, dict) and str(row.get("sender_type", "")).casefold() == "supplier"]
        + [state.get("message", "")]
    )
    fee_status, evidenced_fee = supplier_fee_evidence(supplier_text)
    if fee_status == "unknown":
        proposed.pop("fees_cents", None)
    elif fee_status == "amount":
        proposed["fees_cents"] = evidenced_fee
    elif fee_status == "no_fees":
        proposed["fees_cents"] = 0
    elif previous and previous.get("fees_cents") is not None:
        proposed["fees_cents"] = previous["fees_cents"]
    else:
        proposed.pop("fees_cents", None)

    if proposed.get("product_confirmed") is False and (not previous or previous.get("product_confirmed") is not False):
        if not re.search(r"\b(?:não fornecemos|não temos|não é compatível|incompatível|não atende|não serve)\b", supplier_text, re.I):
            proposed.pop("product_confirmed", None)
    if proposed.get("destination_confirmed") is False and (not previous or previous.get("destination_confirmed") is not False):
        if not re.search(r"\b(?:não entregamos|não enviamos|não atendemos)\s+(?:para|no|na|a esse|esse)\b|\bdestino não atendido\b", supplier_text, re.I):
            proposed.pop("destination_confirmed", None)
    merged = dict(previous or {})
    merged.update(proposed or {})
    normalized = normalize_conversation_terms(merged)
    data["terms"] = normalized
    data["terms_changed"] = normalized != previous
    if re.search(r"\b(?:cotação|proposta).{0,50}\b(?:registrad[ao]s?|concluíd[ao]s?|aprovad[ao]s?|confirmad[ao]s?|encaminhad[ao]s?|submetid[ao]s?|pronta|fechada)\b|\b(?:registrei|registramos|concluí|concluímos|aprovei|aprovamos|encaminhando|encaminhei|encaminhamos|submeti|submetemos|reuni todas as informações|dados completos para avaliação|pedido realizado|compra realizada)\b", data["reply"], re.I):
        missing = []
        for key, label in (("unit_cents", "preço unitário"), ("shipping_cents", "frete"), ("fees_cents", "confirmação de taxas adicionais ou de que não há taxas"),
                           ("lead_days", "prazo"), ("available_qty", "estoque")):
            if not normalized or normalized.get(key) is None:
                missing.append(label)
        if missing:
            data["reply"] = "Para completar os termos da cotação, poderia confirmar " + " e ".join(missing[:2]) + "?"
        else:
            data["reply"] = "Obrigado pelos termos. A decisão ainda depende de avaliação humana; esta resposta não confirma registro, aprovação ou compra."
    if state["phase"] != "purchase":
        data["purchase_acceptance"] = "unclear"
    return {"result": data}


def normalize_conversation_terms(terms: dict | None) -> dict | None:
    if not terms:
        return None
    if hasattr(terms, "model_dump"):
        terms = terms.model_dump(exclude_none=True)
    allowed = set(ConversationTerms.model_fields)
    normalized = {
        key: value.strip() if isinstance(value, str) else value
        for key, value in terms.items()
        if key in allowed and value is not None and not (isinstance(value, str) and value.strip().lower() in {"", "null", "none", "undefined"})
    }
    return normalized or None


def supplier_fee_evidence(text: str) -> tuple[str | None, int | None]:
    """Return fee status only when supplier text states an amount, no fees, or uncertainty."""
    status, amount = None, None
    unknown = re.compile(r"\btaxas?\b.{0,60}\b(?:não|nao)\s+(?:estão?\s+)?(?:confirmad[ao]s?|informad[ao]s?|definid[ao]s?)\b|\b(?:taxas?|impostos?|tarifas?)\b.{0,50}\b(?:desconhecid[ao]s?|pendentes?)\b", re.I)
    fee_labels = r"(?:taxas?|impostos?|tarifas?)(?:\s+(?:adicion(?:al|ais)|extras?|administrativas?|de\s+[a-zà-úç]+))*"
    no_fees = re.compile(
        r"\b(?:sem\s+(?:nenhuma\s+|outras?\s+|mais\s+|qualquer\s+)?" + fee_labels
        + r"|(?:não|nao)\s+(?:há|ha|haverá|havera|existem?|tem|temos|possui|possuímos|cobra|cobramos|incide|incidem)\s+(?:nenhuma\s+|outras?\s+|mais\s+|qualquer\s+)?" + fee_labels
        + r"|isent[oa]s?\s+de\s+" + fee_labels
        + r"|" + fee_labels + r"\s*(?:é|são|=|:)?\s*(?:zero|grátis|gratis|isent[oa]s?)"
        + r"|(?:não|nao)\s+(?:há|ha|tem|temos|cobramos)\s+(?:mais\s+|outras?\s+)?(?:custos?|encargos?)\s+adicionais?"
        + r"|sem\s+(?:mais\s+|outras?\s+)?(?:custos?|encargos?)\s+adicionais?)\b",
        re.I,
    )
    no_more_modifier = re.compile(r"\b(?:mais|outras?|além|adicion(?:al|ais)|extras?)\b", re.I)
    num_pat = r"(\d{1,3}(?:\.\d{3})*(?:,\d{1,2})?|\d+(?:[,.]\d{1,2})?)"
    fee_amount = re.compile(rf"\b{fee_labels}\b(?:\s*(?:de|custa|no\s+valor\s+de|é|são|fica|:|=))+\s*(?:R\$\s*)?{num_pat}\b|\b{fee_labels}\b\s*(?:R\$\s*){num_pat}\b", re.I)
    amount_fee = re.compile(rf"(?:R\$\s*)?{num_pat}(?:\s*(?:reais|r\$))?\s+(?:de\s+)?{fee_labels}\b", re.I)
    for sentence in re.split(r"[.!?;\n]+", text):
        if unknown.search(sentence):
            status, amount = "unknown", None
            continue
        match = fee_amount.search(sentence) or amount_fee.search(sentence)
        if match:
            raw_num = next((g for g in match.groups() if g is not None), None)
            cents = quoted_cents(raw_num, allow_zero=True)
            if cents is not None:
                status, amount = "amount", cents
                continue
        if no_fees.search(sentence):
            if status == "amount" and no_more_modifier.search(sentence):
                continue
            status, amount = "no_fees", 0
            continue
    return status, amount


def to_cents(value: Any, *, allow_zero: bool) -> int | None:
    if value is None:
        return None
    try:
        amount = Decimal(str(value))
    except (InvalidOperation, ValueError):
        return None
    if not amount.is_finite() or amount < (0 if allow_zero else Decimal("0.01")) or amount > Decimal("9999999999.99"):
        return None
    if amount != amount.quantize(Decimal("0.01")):
        return None
    return int(amount * 100)


def quoted_cents(value: str | None, *, allow_zero: bool) -> int | None:
    if value is None:
        return None
    match = re.fullmatch(r"\s*(?:R\$\s*)?([0-9]{1,3}(?:\.[0-9]{3})*|[0-9]+)(?:([,.])([0-9]{1,2}))?\s*", value, re.IGNORECASE)
    if not match:
        return None
    whole = match.group(1).replace(".", "") if match.group(2) == "," else match.group(1)
    decimal = match.group(3) or ""
    try:
        return to_cents(f"{whole}.{decimal.ljust(2, '0') or '00'}", allow_zero=allow_zero)
    except (InvalidOperation, ValueError):
        return None


async def research_node(state: TaskState):
    query = state["product"] + (" " + " ".join(f"{k} {v}" for k, v in state.get("specs", {}).items()) if state.get("specs") else "")
    result = await discover_market(query)
    reputations = []
    reputation_indications = []
    # Reputation is sourced only from the scraper's verified ReclameAqui parser.
    # Keep the external lookup bounded and preserve null scores on every failure.
    if result.products:
        async with MarketScraper() as scraper:
            deadline = asyncio.get_running_loop().time() + 20
            for supplier in list({row.supplier_domain: row for row in result.products}.values())[:3]:
                remaining = deadline - asyncio.get_running_loop().time()
                if remaining <= 0:
                    reputation = Reputation(supplier_domain=supplier.supplier_domain, checked_at=datetime.now(timezone.utc).isoformat(), reason="Consulta de reputação não realizada: limite de tempo da pesquisa atingido.")
                else:
                    try:
                        reputation = await asyncio.wait_for(scraper.reputation(supplier), timeout=min(8, remaining))
                    except TimeoutError:
                        reputation = Reputation(supplier_domain=supplier.supplier_domain, checked_at=datetime.now(timezone.utc).isoformat(), reason="Consulta de reputação excedeu o prazo; nota não verificada.")
                reputations.append(reputation.model_dump(mode="json"))
    if result.products:
        from .search_provider import SearchProviderError, tavily_results
        checked_at = datetime.now(timezone.utc).isoformat()
        for supplier in list({row.supplier_domain: row for row in result.products}.values())[:3]:
            try:
                rows = await tavily_results(f'"{supplier.supplier_domain}" reputação reclamações')
            except SearchProviderError:
                rows = None
            for row in (rows or [])[:3]:
                reputation_indications.append({"supplier_domain": supplier.supplier_domain, "title": str(row.get("title") or "")[:300],
                    "snippet": str(row.get("description") or "")[:1000], "url": row.get("url"), "timestamp": checked_at,
                    "verified": False, "type": "reputation_indication"})
    return {"query": query, "discovery": {"errors": result.errors, "blocked_sites": result.blocked_sites, "query": query},
            "reputations": reputations, "reputation_indications": reputation_indications,
            "raw_quotes": [{"event_id": f"{state['task_id']}:{p.evidence_sha256}", "supplier": p.supplier_name,
                            "unit_price": str(p.price), "shipping": str(p.shipping_fee) if p.shipping_fee is not None else None,
                            "fees": None, "lead_days": None, "available_qty": None, "source_url": p.product_url,
                            "product_confirmed": False, "destination_confirmed": False,
                            "conditions": f"{p.product_name} | {p.product_url} | evidência {p.evidence_sha256}"} for p in result.products]}


async def prepare_node(state: TaskState):
    # Keep only bounded, typed market evidence for the parsing and analysis stages.
    return {"raw_quotes": [dict(row) for row in state.get("raw_quotes", []) if isinstance(row, dict)][:30],
            "agent_notes": {"query": state.get("query", ""), "discovery": state.get("discovery", {}), "reputations": state.get("reputations", []),
                            "reputation_indications": state.get("reputation_indications", [])}}


async def parse_node(state: TaskState):
    if state.get("quote_text"):
        if not settings.active_llm_api_key:
            raise RuntimeError("Interpretação em linguagem natural requer GEMINI_API_KEY ou GROQ_API_KEY configurada")
        extracted = await parse_quote_intelligence(settings.active_llm_model, {
            "message": state["quote_text"], "product": state.get("product"),
            "quantity": state.get("qty"), "destination": state.get("destination"),
        })
        unit = quoted_cents(extracted.unit_price, allow_zero=False)
        parsed = {"supplier": extracted.supplier.strip() if extracted.supplier else None, "unit_cents": unit,
            "shipping_cents": quoted_cents(extracted.shipping, allow_zero=True),
            "fees_cents": quoted_cents(extracted.fees, allow_zero=True), "lead_days": extracted.lead_days,
            "available_qty": extracted.available_qty, "product_confirmed": extracted.product_confirmed,
            "destination_confirmed": extracted.destination_confirmed, "product_denied": extracted.product_denied,
            "destination_denied": extracted.destination_denied, "conditions": extracted.conditions}
        missing = [name for key, name in (("unit_cents", "preço unitário"), ("shipping_cents", "frete"),
                   ("fees_cents", "taxas"), ("lead_days", "prazo"), ("available_qty", "disponibilidade"),
                   ("product_confirmed", "confirmação do produto"), ("destination_confirmed", "confirmação do CEP"))
                   if parsed[key] is None or parsed[key] is False]
        missing = [name for key, denied_key, name in (("product_confirmed", "product_denied", "confirmação do produto"), ("destination_confirmed", "destination_denied", "confirmação do CEP")) if parsed[key] is False and not parsed[denied_key]] + [name for key, name in (("unit_cents", "preço unitário"), ("shipping_cents", "frete"), ("fees_cents", "taxas"), ("lead_days", "prazo"), ("available_qty", "disponibilidade")) if parsed[key] is None]
        parsed["pending"] = missing
        return {"parsed_quote": parsed}
    quotes = []
    for row in state.get("raw_quotes", []):
        unit = to_cents(row.get("unit_price"), allow_zero=False)
        if unit is None or not isinstance(row.get("supplier"), str) or not row["supplier"].strip() or not row.get("event_id"):
            continue
        quotes.append({"event_id": str(row["event_id"])[:200], "supplier": row["supplier"].strip()[:200], "unit_cents": unit,
                       "shipping_cents": to_cents(row.get("shipping"), allow_zero=True),
                       "fees_cents": to_cents(row.get("fees"), allow_zero=True),
                       "lead_days": row.get("lead_days") if isinstance(row.get("lead_days"), int) and 0 <= row["lead_days"] <= 3650 else None,
                       "available_qty": row.get("available_qty") if isinstance(row.get("available_qty"), int) and 0 <= row["available_qty"] <= 1_000_000_000 else None,
                       "source_url": row.get("source_url") if isinstance(row.get("source_url"), str) else None,
                       "product_confirmed": False, "destination_confirmed": False,
                       "conditions": str(row.get("conditions") or "")[:2000]})
    return {"quotes": quotes}


async def analysis_node(state: TaskState):
    notes = dict(state.get("agent_notes", {}))
    if settings.active_llm_api_key:
        calls = (
            ("market_discovery", discovery_intelligence, {"item": state["product"], "quantity": state["qty"], "destination": state["destination"], "offers": state.get("quotes", []), "reputations": state.get("reputations", [])}, "discovery_justification"),
            ("commercial_memory", memory_intelligence, {"supplier_history": [], "statistics": {}, "scope": "business"}, "tactical_briefing"),
            ("quote_request_message", negotiator_intelligence, {"item": state["product"], "specifications": state.get("specs", {}), "quantity": state["qty"], "destination": state["destination"], "confirmed_quotes": state.get("quotes", []), "target_total": None, "history": []}, "mensagem_telegram"),
        )
        for name, invoke, data, attr in calls:
            try:
                result = await invoke(settings.active_llm_model, data)
                notes[name] = getattr(result, attr)
            except Exception as exc:
                notes[f"{name}_status"] = f"unavailable:{type(exc).__name__}"
    else:
        notes.update({"market_discovery_status": "rules_only_no_model_key", "commercial_memory_status": "no_history_available", "negotiation_status": "no_supplier_contact_authorized"})
    return {"agent_notes": notes, "status": "completed"}


graph_builder = StateGraph(TaskState)
graph_builder.add_node("research", research_node)
graph_builder.add_node("prepare", prepare_node)
graph_builder.add_node("parse", parse_node)
graph_builder.add_node("analysis", analysis_node)
graph_builder.add_edge(START, "research")
graph_builder.add_edge("research", "prepare")
graph_builder.add_edge("prepare", "parse")
graph_builder.add_edge("parse", "analysis")
graph_builder.add_edge("analysis", END)

conversation_graph_builder = StateGraph(ConversationState)
conversation_graph_builder.add_node("conversation_turn", conversation_turn_node)
conversation_graph_builder.add_edge(START, "conversation_turn")
conversation_graph_builder.add_edge("conversation_turn", END)

quote_graph_builder = StateGraph(TaskState)
quote_graph_builder.add_node("parse", parse_node)
quote_graph_builder.add_edge(START, "parse")
quote_graph_builder.add_edge("parse", END)


def callback_base_url() -> str:
    """Accept only an origin, keeping callback route construction internal and fixed."""
    value = os.getenv("NEST_API_URL", "http://api:4000").strip()
    try:
        parsed = urlsplit(value)
        valid_host = parsed.hostname in {"api", "localhost", "127.0.0.1"}
        if parsed.scheme != "http" or not valid_host or parsed.username or parsed.password or parsed.path not in {"", "/"} or parsed.query or parsed.fragment:
            raise ValueError
        if parsed.port is not None and not 1 <= parsed.port <= 65535:
            raise ValueError
        return f"http://{parsed.netloc}"
    except (ValueError, TypeError):
        raise RuntimeError("NEST_API_URL deve ser uma origem HTTP interna sem caminho, credenciais ou query") from None


def open_queue(path: str) -> sqlite3.Connection:
    connection = sqlite3.connect(path, timeout=30)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA journal_mode=WAL")
    connection.execute("CREATE TABLE IF NOT EXISTS agent_tasks (task_id TEXT PRIMARY KEY, payload TEXT NOT NULL, status TEXT NOT NULL, output TEXT, attempts INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)")
    connection.commit()
    return connection


@asynccontextmanager
async def lifespan(application: FastAPI):
    checkpoint_path = os.getenv("AGENT_DATABASE_PATH", "/data/agent.sqlite")
    queue_path = os.getenv("AGENT_QUEUE_PATH", checkpoint_path)
    Path(checkpoint_path).parent.mkdir(parents=True, exist_ok=True)
    Path(queue_path).parent.mkdir(parents=True, exist_ok=True)
    application.state.queue_path = queue_path
    with closing(open_queue(queue_path)) as queue:
        queue.execute("UPDATE agent_tasks SET status='queued' WHERE status='running'")
        queue.commit()
    async with AsyncSqliteSaver.from_conn_string(checkpoint_path) as saver:
        await saver.setup()
        application.state.graph = graph_builder.compile(checkpointer=saver)
        application.state.quote_graph = quote_graph_builder.compile(checkpointer=saver)
        application.state.conversation_graph = conversation_graph_builder.compile()
        worker = asyncio.create_task(queue_worker(application))
        try:
            yield
        finally:
            worker.cancel()
            try:
                await worker
            except asyncio.CancelledError:
                pass


app = FastAPI(title="Nexo internal agents", lifespan=lifespan)
app.include_router(voice_router)


@app.get("/health")
async def health():
    return {"status": "ok", "service": "internal-agents"}


class QuoteInterpretRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    request_id: str = Field(min_length=1, max_length=100)
    product: str = Field(min_length=2, max_length=300)
    qty: int = Field(ge=1, le=1_000_000)
    destination: str = Field(min_length=2, max_length=200)
    text: str = Field(min_length=2, max_length=4000)


def require_internal_token(authorization: str | None):
    expected = os.getenv("INTERNAL_API_TOKEN", "")
    received = (authorization or "").removeprefix("Bearer ")
    if not expected or not hmac.compare_digest(expected, received):
        raise HTTPException(401, "Internal API authentication required")


@app.post("/interpret-quote")
async def interpret_quote(payload: QuoteInterpretRequest, authorization: str | None = Header(default=None)):
    require_internal_token(authorization)
    if not settings.active_llm_api_key:
        raise HTTPException(503, "Interpretação natural indisponível: GEMINI_API_KEY ou GROQ_API_KEY não configurada")
    try:
        state = {"request_id": payload.request_id, "product": payload.product, "qty": payload.qty, "destination": payload.destination, "quote_text": payload.text}
        result = await app.state.quote_graph.ainvoke(state, {"configurable": {"thread_id": f"quote-{payload.request_id}-{abs(hash(payload.text))}"}})
        return result["parsed_quote"]
    except (ValueError, RuntimeError) as exc:
        raise HTTPException(422, str(exc)) from exc
    except Exception as exc:
        raise HTTPException(503, f"Interpretação indisponível: {type(exc).__name__}") from exc


class ConversationTurnRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    product: str = Field(min_length=1, max_length=300)
    qty: int = Field(ge=1, le=1_000_000)
    destination: str = Field(min_length=1, max_length=200)
    message: str = Field(min_length=1, max_length=4000)
    history: list[dict[str, str]] = Field(default_factory=list, max_length=30)
    phase: str = Field(pattern=r"^(opening|quotation|quote_confirmation|quote_completed|purchase)$")
    terms: dict | None = None
    missing_fields: list[str] = Field(default_factory=list, max_length=30)

    @field_validator("history")
    @classmethod
    def validate_history(cls, rows):
        for row in rows:
            if set(row) != {"sender_type", "content"} or not row["sender_type"].strip() or len(row["sender_type"]) > 40 or len(row["content"]) > 4000:
                raise ValueError("Histórico inválido")
        return rows

    @field_validator("terms")
    @classmethod
    def validate_terms(cls, terms):
        if terms is not None and (len(terms) > 40 or any(not isinstance(key, str) or len(key) > 80 or (key.endswith("_cents") and value is not None and (isinstance(value, bool) or not isinstance(value, int) or value < 0)) or (isinstance(value, str) and len(value) > 1000) for key, value in terms.items())):
            raise ValueError("Valores monetários devem ser centavos inteiros não negativos")
        return terms


@app.post("/conversation-turn")
async def conversation_turn(payload: ConversationTurnRequest, authorization: str | None = Header(default=None)):
    require_internal_token(authorization)
    if not settings.active_llm_api_key:
        return {"intent": "pending", "reply": "Sua mensagem foi recebida e está com processamento pendente.", "terms": payload.terms,
                "explicit_confirmation": False, "terms_changed": False, "purchase_acceptance": "unclear"}
    try:
        result = await app.state.conversation_graph.ainvoke(payload.model_dump())
        return result["result"]
    except Exception:
        return {"intent": "pending", "reply": "Sua mensagem foi recebida e está com processamento pendente.", "terms": payload.terms,
                "explicit_confirmation": False, "terms_changed": False, "purchase_acceptance": "unclear"}


_reputation_cache: dict[str, tuple[float, dict, list[dict]]] = {}
REPUTATION_REFRESH_TOTAL_BUDGET_SECONDS = 25
REPUTATION_REFRESH_MAX_DOMAINS = 3


class ReputationRefreshRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    offers: list[dict] = Field(max_length=30)


@app.post("/reputation-refresh")
async def reputation_refresh(payload: ReputationRefreshRequest, authorization: str | None = Header(default=None)):
    require_internal_token(authorization)
    from .scraper_tools import domain as supplier_domain
    from .search_provider import tavily_results

    now_mono, checked = time.monotonic(), datetime.now(timezone.utc).isoformat()
    deadline = now_mono + REPUTATION_REFRESH_TOTAL_BUDGET_SECONDS
    reputations, indications = [], []
    offers_by_domain = {}
    for offer in payload.offers:
        url = offer.get("source_url")
        try:
            host = supplier_domain(url) if isinstance(url, str) and url.startswith(("https://", "http://")) else ""
        except Exception:
            host = ""
        if not host:
            reputations.append({"supplier_domain": None, "verified": False, "approved": False, "score": None,
                "reason": "Fornecedor sem URL válida; reputação desconhecida.", "checked_at": checked, "status": "unknown"})
            continue
        offers_by_domain.setdefault(host, url)

    for index, (host, url) in enumerate(offers_by_domain.items()):
        if index >= REPUTATION_REFRESH_MAX_DOMAINS:
            reputations.append({"supplier_domain": host, "verified": False, "approved": False, "score": None,
                "reason": "Consulta não realizada: limite de três domínios por atualização; reputação desconhecida.",
                "checked_at": checked, "status": "skipped_limit"})
            continue
        cached = _reputation_cache.get(host)
        if cached and now_mono - cached[0] < 86400:
            reputations.append(cached[1])
            indications.extend(cached[2])
            continue

        remaining = deadline - time.monotonic()
        official = {"supplier_domain": host, "checked_at": checked, "verified": False, "approved": False, "score": None,
                    "reason": "Consulta oficial não realizada: orçamento total de tempo esgotado; reputação desconhecida.",
                    "status": "skipped_timeout"}
        indicative = []
        if remaining > 0:
            try:
                from .scraper_tools import MarketScraper, ProductOffer
                product = ProductOffer(supplier_name=host, supplier_domain=host, supplier_website=f"https://{host}", product_name="Oferta", product_url=url,
                    price=Decimal("1.00"), availability="unknown", observed_at=checked, extraction_method="reputation_refresh",
                    evidence_sha256=hashlib.sha256(url.encode()).hexdigest())
                async with MarketScraper() as scraper:
                    official = (await asyncio.wait_for(scraper.reputation(product), timeout=min(8, remaining))).model_dump(mode="json")
            except TimeoutError:
                official = {"supplier_domain": host, "checked_at": checked, "verified": False, "approved": False, "score": None,
                    "reason": "Consulta oficial excedeu seu prazo; reputação desconhecida.", "status": "timeout"}
            except Exception:
                official = {"supplier_domain": host, "checked_at": checked, "verified": False, "approved": False, "score": None,
                    "reason": "Reputação oficial indisponível; desconhecida.", "status": "unavailable"}

        remaining = deadline - time.monotonic()
        if remaining > 0:
            try:
                found = await asyncio.wait_for(tavily_results(f'"{host}" reputação reclamações'), timeout=min(5, remaining))
                for row in (found or [])[:5]:
                    indicative.append({"supplier_domain": host, "title": str(row.get("title") or "")[:300],
                        "snippet": str(row.get("description") or "")[:1000], "url": row.get("url"), "timestamp": checked,
                        "verified": False, "type": "reputation_indication"})
            except TimeoutError:
                indicative.append({"supplier_domain": host, "timestamp": checked, "verified": False, "type": "reputation_indication",
                    "status": "timeout", "reason": "Busca Tavily excedeu o tempo restante; nenhum indício coletado."})
            except Exception:
                indicative = []
        else:
            indicative.append({"supplier_domain": host, "timestamp": checked, "verified": False, "type": "reputation_indication",
                "status": "skipped_timeout", "reason": "Busca não realizada: orçamento total de tempo esgotado."})

        _reputation_cache[host] = (now_mono, official, indicative)
        reputations.append(official)
        indications.extend(indicative)
    return {"reputations": reputations, "reputation_indications": indications, "checked_at": checked}


async def deliver_callback(payload: dict, output: dict) -> bool:
    secret = os.getenv("INTERNAL_API_TOKEN", "")
    if not secret:
        return False
    url = f"{callback_base_url()}/tasks/{payload['task_id']}/result"
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            response = await client.post(url, json=output, headers={"authorization": f"Bearer {secret}"})
        # Deleted Nest requests have no callback target; do not block all later research tasks.
        return response.is_success or response.status_code in (404, 410)
    except (httpx.HTTPError, RuntimeError):
        return False


async def process_task(application: FastAPI, task_id: str, payload: dict) -> None:
    with closing(open_queue(application.state.queue_path)) as queue:
        queue.execute("UPDATE agent_tasks SET status='running', attempts=attempts+1, updated_at=CURRENT_TIMESTAMP WHERE task_id=?", (task_id,))
        queue.commit()
    try:
        result = await application.state.graph.ainvoke({**payload, "status": "running"}, {"configurable": {"thread_id": task_id}})
        output = {"status": "completed", "quotes": result.get("quotes", []), "execution_version": payload["execution_version"], "agent_notes": result.get("agent_notes", {}), "discovery": result.get("discovery", {})}
    except Exception as exc:
        output = {"status": "failed", "quotes": [], "execution_version": payload["execution_version"], "error": type(exc).__name__}
    encoded = json.dumps(output, separators=(",", ":"))
    with closing(open_queue(application.state.queue_path)) as queue:
        queue.execute("UPDATE agent_tasks SET status='callback_pending', output=?, updated_at=CURRENT_TIMESTAMP WHERE task_id=?", (encoded, task_id))
        queue.commit()


async def queue_worker(application: FastAPI) -> None:
    while True:
        with closing(open_queue(application.state.queue_path)) as queue:
            row = queue.execute("SELECT task_id,payload,status,output FROM agent_tasks WHERE status IN ('queued','callback_pending') ORDER BY updated_at LIMIT 1").fetchone()
        if row is None:
            await asyncio.sleep(0.5)
            continue
        if row["status"] == "queued":
            await process_task(application, row["task_id"], json.loads(row["payload"]))
            continue
        payload = json.loads(row["payload"])
        output = json.loads(row["output"])
        if await deliver_callback(payload, output):
            with closing(open_queue(application.state.queue_path)) as queue:
                queue.execute("UPDATE agent_tasks SET status='delivered', updated_at=CURRENT_TIMESTAMP WHERE task_id=? AND status='callback_pending'", (row["task_id"],))
                queue.commit()
        else:
            await asyncio.sleep(2)


@app.post("/tasks", status_code=202)
async def create_task(payload: TaskRequest, authorization: str | None = Header(default=None)):
    require_internal_token(authorization)
    normalized = payload.model_dump()
    with closing(open_queue(app.state.queue_path)) as queue:
        queue.execute("INSERT OR IGNORE INTO agent_tasks(task_id,payload,status) VALUES(?,?,'queued')", (payload.task_id, json.dumps(normalized, separators=(",", ":"))))
        row = queue.execute("SELECT payload FROM agent_tasks WHERE task_id=?", (payload.task_id,)).fetchone()
        if row["payload"] != json.dumps(normalized, separators=(",", ":")):
            raise HTTPException(409, "Task ID already exists with different payload")
        queue.commit()
    return {"accepted": True, "task_id": payload.task_id}
