from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from .config import settings


options = {"pool_pre_ping": True}
if settings.database_url.startswith("sqlite"):
    options["connect_args"] = {"check_same_thread": False, "timeout": 30}
    if settings.database_url in {"sqlite://", "sqlite:///:memory:"}:
        options["poolclass"] = StaticPool

engine = create_engine(settings.database_url, **options)
SessionLocal = sessionmaker(bind=engine, expire_on_commit=False)

if engine.dialect.name == "sqlite":
    @event.listens_for(engine, "connect")
    def configure_sqlite(connection, connection_record):
        cursor = connection.cursor()
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.execute("PRAGMA busy_timeout=30000")
        cursor.execute("PRAGMA journal_mode=WAL")
        cursor.close()


from sqlalchemy import String, Text, Integer, ForeignKey, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column
from .models import Base


class SupplierMemory(Base):
    __tablename__ = 'telegram_supplier_memory'
    domain: Mapped[str] = mapped_column(String(255), primary_key=True)
    name: Mapped[str] = mapped_column(String(300))
    chat_id: Mapped[int | None] = mapped_column(Integer, unique=True, nullable=True)
    summary: Mapped[str] = mapped_column(Text, default='')
    invite_hash: Mapped[str | None] = mapped_column(String(64), unique=True, nullable=True)
    invite_expires: Mapped[str | None] = mapped_column(String(40), nullable=True)
    authorized_at: Mapped[str | None] = mapped_column(String(40), nullable=True)


class ChatMessage(Base):
    __tablename__ = 'telegram_chat_messages'
    __table_args__ = (UniqueConstraint('chat_id', 'telegram_message_id'),)
    id: Mapped[int] = mapped_column(primary_key=True)
    request_id: Mapped[int] = mapped_column(ForeignKey('real_market_runs.id'), index=True)
    supplier_domain: Mapped[str] = mapped_column(String(255), index=True)
    chat_id: Mapped[int] = mapped_column(Integer)
    sender_type: Mapped[str] = mapped_column(String(16))
    text: Mapped[str] = mapped_column(Text)
    timestamp: Mapped[str] = mapped_column(String(40))
    delivery_status: Mapped[str] = mapped_column(String(24), default='received')
    action_key: Mapped[str | None] = mapped_column(String(180), unique=True, nullable=True)
    telegram_message_id: Mapped[int | None] = mapped_column(Integer, nullable=True)


class AgentJob(Base):
    __tablename__ = 'telegram_agent_jobs'
    request_id: Mapped[int] = mapped_column(ForeignKey('real_market_runs.id'), primary_key=True)
    generation: Mapped[int] = mapped_column(Integer, default=1)
    status: Mapped[str] = mapped_column(String(24), default='pending', index=True)
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)


class TelegramUpdate(Base):
    __tablename__ = 'telegram_updates'
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=False)
    request_id: Mapped[int | None] = mapped_column(ForeignKey('real_market_runs.id'), nullable=True, index=True)
    message_id: Mapped[int | None] = mapped_column(ForeignKey('telegram_chat_messages.id'), nullable=True)
    processed: Mapped[bool] = mapped_column(default=False, index=True)
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)


class SupplierOutcome(Base):
    __tablename__ = 'telegram_supplier_outcomes'
    request_id: Mapped[int] = mapped_column(ForeignKey('real_market_runs.id'), primary_key=True)
    supplier_domain: Mapped[str] = mapped_column(String(255), index=True)
    mode: Mapped[str] = mapped_column(String(16), index=True)
    product_name: Mapped[str] = mapped_column(String(1000))
    summary: Mapped[str] = mapped_column(Text)
    recorded_at: Mapped[str] = mapped_column(String(40))


class AgentTrace(Base):
    __tablename__ = 'procurement_agent_traces'
    id: Mapped[int] = mapped_column(primary_key=True)
    request_id: Mapped[int] = mapped_column(ForeignKey('real_market_runs.id'), index=True)
    generation: Mapped[int] = mapped_column(Integer)
    node: Mapped[str] = mapped_column(String(64))
    status: Mapped[str] = mapped_column(String(16))
    started_at: Mapped[str] = mapped_column(String(40))
    finished_at: Mapped[str | None] = mapped_column(String(40), nullable=True)
    input_json: Mapped[str] = mapped_column(Text)
    output_json: Mapped[str | None] = mapped_column(Text, nullable=True)
    error_type: Mapped[str | None] = mapped_column(String(100), nullable=True)
