import os
from tempfile import TemporaryDirectory

import pytest


directory = TemporaryDirectory(prefix="nexo-tests-")
os.environ["DATABASE_URL"] = "sqlite:///" + directory.name + "/test.db"
os.environ["SEED_DEMO_DATA"] = "false"
os.environ["TAVILY_API_KEY"] = ""
os.environ["SEARCH_CREDENTIALS_PATH"] = directory.name + "/search_credentials.json"
os.environ["MOCK_VOICE_DELAY_SECONDS"] = "0"
os.environ["VOICE_WEBHOOK_SECRET"] = "test-secret"
os.environ["MY_TELEGRAM_CHAT_ID"] = ""
os.environ["GROQ_API_KEY"] = ""
os.environ["GEMINI_API_KEY"] = ""
os.environ["TELEGRAM_BOT_TOKEN"] = ""
os.environ["TELEGRAM_WEBHOOK_SECRET"] = "test-telegram-secret"
os.environ["AGENT_CHECKPOINT_PATH"] = directory.name + "/checkpoints.db"
os.environ["LANGSMITH_TRACING"] = "false"
os.environ['ALLOWED_HOSTS'] = 'testserver,localhost,127.0.0.1'
os.environ['MUTATIONS_PER_MINUTE'] = '10000'

from fastapi.testclient import TestClient
from fastapi import FastAPI
from app.database import engine
from app.main import app, lifespan
from app.models import Base
from app.routers.api import router as legacy_router
from app.routers.voice_webhook import router as legacy_voice_router
from app.orchestrator_simulation import router as simulation_router
from fastapi.middleware.cors import CORSMiddleware

legacy_app = FastAPI(lifespan=lifespan)
legacy_app.add_middleware(CORSMiddleware, allow_origins=['http://localhost:3000'], allow_methods=['GET', 'POST', 'OPTIONS'], allow_headers=['Idempotency-Key'])
legacy_app.include_router(legacy_router)
legacy_app.include_router(legacy_voice_router)
legacy_app.include_router(simulation_router)


@pytest.fixture
def client(tmp_path, monkeypatch):
    from app.config import settings
    monkeypatch.setattr(settings, "agent_checkpoint_path", tmp_path / "checkpoints.db")
    Base.metadata.drop_all(engine)
    with TestClient(app) as client:
        yield client


@pytest.fixture
def legacy_client():
    Base.metadata.drop_all(engine)
    with TestClient(legacy_app) as client:
        yield client


@pytest.fixture
def supplier(legacy_client):
    response = legacy_client.post("/supplier", json={"name": "Fornecedor de teste", "phone": "+5511999999999"})
    assert response.status_code == 201
    return response.json()
