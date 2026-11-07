import argparse
import json
import logging
from decimal import Decimal, ROUND_HALF_UP
from functools import partial
from typing import Callable, Literal

from langchain_core.runnables import RunnableLambda
from langgraph.graph import END, START, StateGraph
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select, update
from typing_extensions import NotRequired, TypedDict

from .config import settings
from .database import SessionLocal, engine
from .models import Base, PurchaseRequest, Quote, RequestStatus, Supplier
from .schemas import VoiceWebhook
from .services import persist_voice_quote
from time import sleep


MAX_ROUNDS = 3
CENT = Decimal("0.01")
MAX_PRICE = Decimal("9999999999.99")
logger = logging.getLogger(__name__)


class NegotiationState(TypedDict):
    request_id: int
    target_price: float
    supplier_memory: str
    current_offer: float
    negotiation_rounds: int
    status: str
    supplier_id: NotRequired[int]
    item: NotRequired[str]
    qty: NotRequired[int]
    initial_price: NotRequired[float]
    historical_price: NotRequired[float | None]
    available_qty: NotRequired[int]
    delivery_time: NotRequired[str]
    conditions: NotRequired[str]
    accepted: NotRequired[bool]
    counter_offer_script: NotRequired[str]
    quote_id: NotRequired[int]
    savings_achieved: NotRequired[str]
    termination_reason: NotRequired[str]


class WorkflowInput(BaseModel):
    request_id: int = Field(gt=0, strict=True)
    supplier_id: int | None = Field(default=None, gt=0, strict=True)


class MockVoiceConfig(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    initial_markup: Decimal = Field(default=Decimal("1.20"), gt=0, le=10)
    repeat_markup: Decimal = Field(default=Decimal("1.05"), gt=0, le=10)
    discount_per_round: Decimal = Field(default=Decimal("0.10"), ge=0, le=1)
    minimum_price_ratio: Decimal = Field(default=Decimal("0.80"), gt=0, le=1)
    delivery_time: str = Field(default="5 business days", min_length=1, max_length=300)
    conditions: str = Field(default="Net 30; delivery included", max_length=4000)


class OfferDecision(BaseModel):
    accepted: bool


class CounterOffer(BaseModel):
    price: Decimal = Field(gt=0, max_digits=12, decimal_places=2)
    script: str = Field(min_length=1, max_length=2000)


def money(value: Decimal | float | str) -> Decimal:
    result = Decimal(str(value))
    if not result.is_finite() or result < 0 or result > MAX_PRICE:
        raise ValueError("Price must be finite and between zero and 9999999999.99")
    return result.quantize(CENT, rounding=ROUND_HALF_UP)


class MockVoiceAgent:
    def __init__(self, config: MockVoiceConfig | None = None):
        self.config = config or MockVoiceConfig()

    def initial_quote(self, state: NegotiationState) -> VoiceWebhook:
        sleep(settings.mock_voice_delay_seconds)
        previous = state.get("historical_price")
        baseline = money(previous) if previous is not None else money(state["target_price"])
        markup = self.config.repeat_markup if previous is not None else self.config.initial_markup
        price = money(min(MAX_PRICE, max(CENT, baseline * markup)))
        return VoiceWebhook(
            request_id=state["request_id"],
            supplier_id=state["supplier_id"],
            initial_price=price,
            final_price=price,
            available_qty=state["qty"],
            delivery_time=self.config.delivery_time,
            conditions=self.config.conditions,
        )

    def negotiate(self, state: NegotiationState, counter: CounterOffer) -> Decimal:
        sleep(settings.mock_voice_delay_seconds)
        current = money(state["current_offer"])
        floor = money(money(state["initial_price"]) * self.config.minimum_price_ratio)
        discounted = money(current * (1 - self.config.discount_per_round))
        return min(current, max(floor, counter.price, discounted))


def mock_evaluate_offer(state: NegotiationState) -> OfferDecision:
    return OfferDecision(accepted=money(state["current_offer"]) <= money(state["target_price"]))


def mock_generate_counter_offer(state: NegotiationState) -> CounterOffer:
    target = money(state["target_price"])
    history = state.get("historical_price")
    reference = (
        f"Our last agreed unit price for this item was {money(history):.2f}. "
        if history is not None
        else ""
    )
    return CounterOffer(
        price=target,
        script=(
            f"Thank you for quoting {money(state['current_offer']):.2f} per unit "
            f"for {state['qty']} units of {state['item']}. {reference}"
            f"Can you offer {target:.2f} per unit while keeping the quoted "
            "quantity, delivery time, and payment terms? Please confirm your best price."
        ),
    )


decision_chain = RunnableLambda(mock_evaluate_offer)
counter_offer_chain = RunnableLambda(mock_generate_counter_offer)


def fetch_memory(state: NegotiationState) -> dict:
    inputs = WorkflowInput.model_validate(
        {"request_id": state.get("request_id"), "supplier_id": state.get("supplier_id")}
    )
    with SessionLocal.begin() as session:
        request = session.get(PurchaseRequest, inputs.request_id)
        if request is None:
            raise ValueError("Purchase request not found")
        existing = session.scalar(select(Quote).where(Quote.request_id == request.id))
        supplier_id = inputs.supplier_id or request.supplier_id
        supplier = (
            session.get(Supplier, supplier_id)
            if supplier_id is not None
            else session.scalar(select(Supplier).order_by(Supplier.id).limit(1))
        )
        if supplier is None:
            raise ValueError("Create a supplier before starting negotiation")
        if existing is not None and existing.supplier_id != supplier.id:
            raise ValueError("Completed request belongs to a different supplier")
        context = {
            "request_id": request.id,
            "supplier_id": supplier.id,
            "target_price": float(request.target_price),
            "item": request.item,
            "qty": request.qty,
            "supplier_memory": supplier.memory_summary_vector_mock,
            "current_offer": 0.0,
            "negotiation_rounds": existing.negotiation_rounds if existing else 0,
            "accepted": False,
            "counter_offer_script": "",
        }
        if existing is not None:
            return {
                **context,
                "status": RequestStatus.DONE.value,
                "initial_price": float(existing.initial_price),
                "current_offer": float(existing.final_price),
                "available_qty": existing.available_qty,
                "delivery_time": existing.delivery_time,
                "conditions": existing.conditions,
                "accepted": existing.final_price <= request.target_price,
                "quote_id": existing.id,
                "savings_achieved": str(existing.savings_achieved),
                "termination_reason": "already_completed",
            }
        if request.status == RequestStatus.DONE:
            raise ValueError("Completed request has no final quote")
        previous = session.scalar(
            select(Quote.final_price)
            .join(PurchaseRequest, Quote.request_id == PurchaseRequest.id)
            .where(
                Quote.supplier_id == supplier.id,
                PurchaseRequest.item == request.item,
                PurchaseRequest.status == RequestStatus.DONE,
            )
            .order_by(Quote.id.desc())
            .limit(1)
        )
        claimed = session.execute(
            update(PurchaseRequest)
            .where(PurchaseRequest.id == request.id, PurchaseRequest.status == RequestStatus.TODO)
            .values(status=RequestStatus.CALLING, last_error=None)
        )
        if claimed.rowcount != 1:
            raise RuntimeError("Negotiation is already running for this request")
        return {
            **context,
            "historical_price": float(previous) if previous is not None else None,
            "status": RequestStatus.CALLING.value,
        }


def initiate_voice_call(state: NegotiationState, voice: MockVoiceAgent) -> dict:
    quote = voice.initial_quote(state)
    if quote.available_qty < state["qty"]:
        raise ValueError("Supplier cannot fulfill the requested quantity")
    return {
        "initial_price": float(quote.initial_price),
        "current_offer": float(quote.final_price),
        "available_qty": quote.available_qty,
        "delivery_time": quote.delivery_time,
        "conditions": quote.conditions,
    }


def evaluate_offer(state: NegotiationState) -> dict:
    decision = decision_chain.invoke(state)
    return {"accepted": decision.accepted}


def route_offer(state: NegotiationState) -> Literal["counter_offer", "finalize_quote"]:
    if not state["accepted"] and state["negotiation_rounds"] < MAX_ROUNDS:
        return "counter_offer"
    return "finalize_quote"


def counter_offer(state: NegotiationState, voice: MockVoiceAgent) -> dict:
    if state["negotiation_rounds"] >= MAX_ROUNDS:
        raise RuntimeError("Negotiation round limit reached")
    with SessionLocal.begin() as session:
        changed = session.execute(
            update(PurchaseRequest)
            .where(
                PurchaseRequest.id == state["request_id"],
                PurchaseRequest.status.in_([RequestStatus.CALLING, RequestStatus.NEGOTIATING]),
            )
            .values(status=RequestStatus.NEGOTIATING)
        )
        if changed.rowcount != 1:
            raise RuntimeError("Request is no longer available for negotiation")
    counter = counter_offer_chain.invoke(state)
    offer = money(voice.negotiate(state, counter))
    if offer > money(state["current_offer"]):
        raise ValueError("Counter-offer cannot increase the agreed price")
    return {
        "current_offer": float(offer),
        "negotiation_rounds": state["negotiation_rounds"] + 1,
        "status": RequestStatus.NEGOTIATING.value,
        "counter_offer_script": counter.script,
    }


def finalize_quote(state: NegotiationState) -> dict:
    quote = persist_voice_quote(
        VoiceWebhook(
            request_id=state["request_id"],
            supplier_id=state["supplier_id"],
            initial_price=money(state["initial_price"]),
            final_price=money(state["current_offer"]),
            delivery_time=state["delivery_time"],
            available_qty=state["available_qty"],
            conditions=state["conditions"],
            negotiation_rounds=state["negotiation_rounds"],
        )
    )
    return {
        "status": RequestStatus.DONE.value,
        "quote_id": quote.id,
        "savings_achieved": str(quote.savings_achieved),
        "termination_reason": "target_met" if state["accepted"] else "max_rounds_reached",
    }


def guarded(node: Callable) -> Callable:
    def execute(state: NegotiationState) -> dict:
        try:
            return node(state)
        except Exception:
            try:
                with SessionLocal.begin() as session:
                    session.execute(
                        update(PurchaseRequest)
                        .where(
                            PurchaseRequest.id == state["request_id"],
                            PurchaseRequest.status.in_(
                                [RequestStatus.CALLING, RequestStatus.NEGOTIATING]
                            ),
                        )
                        .values(status=RequestStatus.TODO, last_error="Não foi possível concluir a negociação. Tente novamente.")
                    )
            except Exception:
                logger.exception("Could not reset failed request %s", state["request_id"])
            raise
    return execute


def build_graph(voice: MockVoiceAgent | None = None):
    voice = voice or MockVoiceAgent()
    builder = StateGraph(NegotiationState)
    builder.add_node("fetch_memory", fetch_memory)
    builder.add_node("initiate_voice_call", guarded(partial(initiate_voice_call, voice=voice)))
    builder.add_node("evaluate_offer", guarded(evaluate_offer))
    builder.add_node("counter_offer", guarded(partial(counter_offer, voice=voice)))
    builder.add_node("finalize_quote", guarded(finalize_quote))
    builder.add_edge(START, "fetch_memory")
    builder.add_conditional_edges(
        "fetch_memory",
        lambda state: "completed" if state["status"] == RequestStatus.DONE.value else "call",
        {"completed": END, "call": "initiate_voice_call"},
    )
    builder.add_edge("initiate_voice_call", "evaluate_offer")
    builder.add_conditional_edges(
        "evaluate_offer", route_offer,
        {"counter_offer": "counter_offer", "finalize_quote": "finalize_quote"},
    )
    builder.add_edge("counter_offer", "evaluate_offer")
    builder.add_edge("finalize_quote", END)
    return builder.compile()


graph = build_graph()


def run_negotiation(request_id: int, supplier_id: int | None = None) -> NegotiationState:
    inputs = WorkflowInput(request_id=request_id, supplier_id=supplier_id)
    return graph.invoke(inputs.model_dump(exclude_none=True), config={"recursion_limit": 20})


async def arun_negotiation(request_id: int, supplier_id: int | None = None) -> NegotiationState:
    inputs = WorkflowInput(request_id=request_id, supplier_id=supplier_id)
    return await graph.ainvoke(inputs.model_dump(exclude_none=True), config={"recursion_limit": 20})


async def process_purchase_request(request_id: int) -> None:
    try:
        await arun_negotiation(request_id)
    except Exception:
        logger.exception("Negotiation failed for request %s", request_id)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("request_id", type=int)
    parser.add_argument("--supplier-id", type=int)
    args = parser.parse_args()
    Base.metadata.create_all(engine)
    try:
        print(json.dumps(run_negotiation(args.request_id, args.supplier_id), indent=2))
    finally:
        engine.dispose()
