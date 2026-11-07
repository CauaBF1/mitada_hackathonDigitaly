from datetime import datetime, timezone
from decimal import Decimal, ROUND_HALF_UP
from enum import Enum

from sqlalchemy import CheckConstraint, DateTime, Enum as SQLAlchemyEnum, ForeignKey, Integer, Numeric, String, Text
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship

CENT = Decimal("0.01")


class RequestStatus(str, Enum):
    TODO = "TODO"
    CALLING = "CALLING"
    NEGOTIATING = "NEGOTIATING"
    DONE = "DONE"


class Base(DeclarativeBase):
    pass


class Supplier(Base):
    __tablename__ = "suppliers"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(200))
    phone: Mapped[str] = mapped_column(String(32), unique=True)
    memory_summary_vector_mock: Mapped[str] = mapped_column(Text, default="")


class PurchaseRequest(Base):
    __tablename__ = "purchase_requests"
    __table_args__ = (
        CheckConstraint("target_price > 0", name="positive_target_price"),
        CheckConstraint("qty > 0", name="positive_request_quantity"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    supplier_id: Mapped[int] = mapped_column(ForeignKey("suppliers.id"), index=True)
    client_request_id: Mapped[str | None] = mapped_column(String(64), unique=True)
    last_error: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), onupdate=lambda: datetime.now(timezone.utc))
    supplier: Mapped[Supplier] = relationship(lazy="joined")
    quote: Mapped["Quote | None"] = relationship(back_populates="purchase_request", uselist=False, lazy="selectin")
    item: Mapped[str] = mapped_column(String(300))
    target_price: Mapped[Decimal] = mapped_column(Numeric(12, 2))
    qty: Mapped[int] = mapped_column(Integer)
    status: Mapped[RequestStatus] = mapped_column(
        SQLAlchemyEnum(RequestStatus, native_enum=False, create_constraint=True),
        default=RequestStatus.TODO,
        index=True,
    )


class Quote(Base):
    __tablename__ = "quotes"
    __table_args__ = (
        CheckConstraint("initial_price > 0", name="positive_initial_price"),
        CheckConstraint("final_price >= 0", name="nonnegative_final_price"),
        CheckConstraint("available_qty >= 0", name="nonnegative_available_quantity"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    request_id: Mapped[int] = mapped_column(
        ForeignKey("purchase_requests.id"), unique=True
    )
    supplier_id: Mapped[int] = mapped_column(ForeignKey("suppliers.id"), index=True)
    initial_price: Mapped[Decimal] = mapped_column(Numeric(12, 2))
    final_price: Mapped[Decimal] = mapped_column(Numeric(12, 2))
    delivery_time: Mapped[str] = mapped_column(String(300))
    available_qty: Mapped[int] = mapped_column(Integer)
    conditions: Mapped[str] = mapped_column(Text, default="")
    negotiation_rounds: Mapped[int] = mapped_column(Integer, default=0)
    purchase_request: Mapped[PurchaseRequest] = relationship(back_populates="quote", lazy="joined")

    @property
    def savings_achieved(self) -> Decimal:
        return ((self.initial_price - self.final_price) * self.purchase_request.qty).quantize(
            CENT, rounding=ROUND_HALF_UP
        )


class VoiceCall(Base):
    __tablename__ = "voice_calls"

    id: Mapped[str] = mapped_column(String(128), primary_key=True)
    request_id: Mapped[int] = mapped_column(ForeignKey("purchase_requests.id"), unique=True)
    supplier_id: Mapped[int] = mapped_column(ForeignKey("suppliers.id"))
    status: Mapped[str] = mapped_column(String(32), default="queued")
    pending_payload: Mapped[str | None] = mapped_column(Text)
    outbound_payload: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))


