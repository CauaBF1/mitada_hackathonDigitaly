import os
import sys
from pathlib import Path
from tempfile import TemporaryDirectory

import uvicorn


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))
with TemporaryDirectory(prefix="nexo-e2e-") as directory:
    os.environ["DATABASE_URL"] = "sqlite:///" + str(Path(directory) / "test.db")
    os.environ["SEED_DEMO_DATA"] = "false"
    os.environ["TAVILY_API_KEY"] = ""
    os.environ["CORS_ORIGINS"] = "http://127.0.0.1:3100"
    os.environ["SEARCH_CREDENTIALS_PATH"] = str(Path(directory) / "search_credentials.json")
    os.environ["DISCOVERY_TIMEOUT_SECONDS"] = "10"
    os.environ["SCRAPE_TIMEOUT_SECONDS"] = "3"
    os.environ["MY_TELEGRAM_CHAT_ID"] = "555123"
    os.environ["GROQ_API_KEY"] = ""
    os.environ["TELEGRAM_BOT_TOKEN"] = ""
    os.environ["TELEGRAM_WEBHOOK_SECRET"] = ""
    os.environ["AGENT_CHECKPOINT_PATH"] = str(Path(directory) / "agent.db")
    os.environ["VOICE_WEBHOOK_SECRET"] = ""
    os.environ["LANGSMITH_TRACING"] = "false"
    uvicorn.run("app.main:app", host="127.0.0.1", port=8001)
