"""Internal research agent. Business records remain owned by NestJS."""
import asyncio
import hmac
import json
import os
import re
import sqlite3
from contextlib import asynccontextmanager
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any, TypedDict
from urllib.parse import urlsplit

import httpx
from fastapi import FastAPI, Header, HTTPException
from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver
from langgraph.graph import END, START, StateGraph
from pydantic import BaseModel, ConfigDict, Field, field_validator

from .agent_intelligence import discovery_intelligence, memory_intelligence, negotiator_intelligence, parse_quote_intelligence
from .config import settings
from .scraper_tools import discover_market


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
    status: str
    agent_notes: dict


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
    return {"query": query, "discovery": {"errors": result.errors, "blocked_sites": result.blocked_sites, "query": query},
            "raw_quotes": [{"event_id": f"{state['task_id']}:{p.evidence_sha256}", "supplier": p.supplier_name,
                            "unit_price": str(p.price), "shipping": str(p.shipping_fee) if p.shipping_fee is not None else None,
                            "fees": None, "lead_days": None, "available_qty": None, "source_url": p.product_url,
                            "product_confirmed": False, "destination_confirmed": False,
                            "conditions": f"{p.product_name} | {p.product_url} | evidência {p.evidence_sha256}"} for p in result.products]}


async def prepare_node(state: TaskState):
    # Keep only bounded, typed market evidence for the parsing and analysis stages.
    return {"raw_quotes": [dict(row) for row in state.get("raw_quotes", []) if isinstance(row, dict)][:30],
            "agent_notes": {"query": state.get("query", ""), "discovery": state.get("discovery", {})}}


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
            ("market_discovery", discovery_intelligence, {"item": state["product"], "quantity": state["qty"], "destination": state["destination"], "offers": state.get("quotes", []), "reputations": []}, "discovery_justification"),
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
    with open_queue(queue_path) as queue:
        queue.execute("UPDATE agent_tasks SET status='queued' WHERE status='running'")
        queue.commit()
    async with AsyncSqliteSaver.from_conn_string(checkpoint_path) as saver:
        await saver.setup()
        application.state.graph = graph_builder.compile(checkpointer=saver)
        application.state.quote_graph = quote_graph_builder.compile(checkpointer=saver)
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


async def deliver_callback(payload: dict, output: dict) -> bool:
    secret = os.getenv("INTERNAL_API_TOKEN", "")
    if not secret:
        return False
    url = f"{callback_base_url()}/tasks/{payload['task_id']}/result"
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            response = await client.post(url, json=output, headers={"authorization": f"Bearer {secret}"})
        return response.is_success
    except (httpx.HTTPError, RuntimeError):
        return False


async def process_task(application: FastAPI, task_id: str, payload: dict) -> None:
    with open_queue(application.state.queue_path) as queue:
        queue.execute("UPDATE agent_tasks SET status='running', attempts=attempts+1, updated_at=CURRENT_TIMESTAMP WHERE task_id=?", (task_id,))
        queue.commit()
    try:
        result = await application.state.graph.ainvoke({**payload, "status": "running"}, {"configurable": {"thread_id": task_id}})
        output = {"status": "completed", "quotes": result.get("quotes", []), "execution_version": payload["execution_version"], "agent_notes": result.get("agent_notes", {}), "discovery": result.get("discovery", {})}
    except Exception as exc:
        output = {"status": "failed", "quotes": [], "execution_version": payload["execution_version"], "error": type(exc).__name__}
    encoded = json.dumps(output, separators=(",", ":"))
    with open_queue(application.state.queue_path) as queue:
        queue.execute("UPDATE agent_tasks SET status='callback_pending', output=?, updated_at=CURRENT_TIMESTAMP WHERE task_id=?", (encoded, task_id))
        queue.commit()


async def queue_worker(application: FastAPI) -> None:
    while True:
        with open_queue(application.state.queue_path) as queue:
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
            with open_queue(application.state.queue_path) as queue:
                queue.execute("UPDATE agent_tasks SET status='delivered', updated_at=CURRENT_TIMESTAMP WHERE task_id=? AND status='callback_pending'", (row["task_id"],))
                queue.commit()
        else:
            await asyncio.sleep(2)


@app.post("/tasks", status_code=202)
async def create_task(payload: TaskRequest, authorization: str | None = Header(default=None)):
    require_internal_token(authorization)
    normalized = payload.model_dump()
    with open_queue(app.state.queue_path) as queue:
        queue.execute("INSERT OR IGNORE INTO agent_tasks(task_id,payload,status) VALUES(?,?,'queued')", (payload.task_id, json.dumps(normalized, separators=(",", ":"))))
        row = queue.execute("SELECT payload FROM agent_tasks WHERE task_id=?", (payload.task_id,)).fetchone()
        if row["payload"] != json.dumps(normalized, separators=(",", ":")):
            raise HTTPException(409, "Task ID already exists with different payload")
        queue.commit()
    return {"accepted": True, "task_id": payload.task_id}
