from datetime import datetime, timezone
from decimal import Decimal
from typing import Annotated

from pydantic import BaseModel, ConfigDict, Field, field_serializer

from .models import RequestStatus


PositiveMoney = Annotated[Decimal, Field(gt=0, max_digits=12, decimal_places=2)]
NonnegativeMoney = Annotated[Decimal, Field(ge=0, max_digits=12, decimal_places=2)]
PositiveId = Annotated[int, Field(gt=0, strict=True)]


class Schema(BaseModel):
    model_config = ConfigDict(from_attributes=True, extra="forbid", str_strip_whitespace=True)


class SupplierCreate(Schema):
    name: str = Field(min_length=1, max_length=200)
    phone: str = Field(pattern=r"^\+[1-9]\d{6,14}$")
    memory_summary_vector_mock: str = Field(default="", max_length=16000)


class SupplierRead(SupplierCreate):
    id: int


class PurchaseRequestCreate(Schema):
    item: str = Field(min_length=1, max_length=300)
    target_price: PositiveMoney
    qty: int = Field(gt=0, le=1_000_000, strict=True)
    supplier_id: PositiveId | None = None


class VoiceWebhook(Schema):
    request_id: PositiveId
    supplier_id: PositiveId
    initial_price: PositiveMoney
    final_price: NonnegativeMoney
    delivery_time: str = Field(min_length=1, max_length=300)
    available_qty: int = Field(ge=0, le=2_147_483_647, strict=True)
    conditions: str = Field(default="", max_length=4000)
    negotiation_rounds: int = Field(default=0, ge=0, le=3, strict=True)


class QuoteRead(VoiceWebhook):
    id: int
    savings_achieved: Decimal


class PurchaseRequestRead(PurchaseRequestCreate):
    id: int
    status: RequestStatus
    supplier: SupplierRead
    quote: QuoteRead | None = None
    last_error: str | None = None
    created_at: datetime
    updated_at: datetime

    @field_serializer("created_at", "updated_at")
    def serialize_time(self, value: datetime) -> str:
        return value.replace(tzinfo=value.tzinfo or timezone.utc).astimezone(timezone.utc).isoformat()


class KanbanRead(Schema):
    TODO: list[PurchaseRequestRead] = Field(default_factory=list)
    CALLING: list[PurchaseRequestRead] = Field(default_factory=list)
    NEGOTIATING: list[PurchaseRequestRead] = Field(default_factory=list)
    DONE: list[PurchaseRequestRead] = Field(default_factory=list)


class DashboardMetrics(Schema):
    total_savings: Decimal
    average_discount_percentage: Decimal
    successful_negotiations_count: int
