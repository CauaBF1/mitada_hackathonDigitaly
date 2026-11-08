from pydantic import Field, SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict
from pathlib import Path
import os
import re
from dotenv import load_dotenv


_BACKEND_ENV = Path(__file__).resolve().parents[1] / '.env'
_ROOT_ENV = Path(__file__).resolve().parents[2] / '.env'
load_dotenv(_BACKEND_ENV, override=False)
load_dotenv(_ROOT_ENV, override=False)


def personal_telegram_chat_id() -> int:
    raw = os.getenv("MY_TELEGRAM_CHAT_ID")
    if not raw or not re.fullmatch(r'[1-9][0-9]{0,15}', raw.strip()):
        raise ValueError('Configure MY_TELEGRAM_CHAT_ID no .env com o ID positivo da sua conversa pessoal, não o número de telefone.')
    value = int(raw.strip())
    if value >= 2**52:
        raise ValueError('MY_TELEGRAM_CHAT_ID excede o limite de um identificador Telegram.')
    return value


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    database_url: str = "sqlite:///./procurement.db"
    cors_origins: str = "http://localhost:3000,http://127.0.0.1:3000"
    allowed_hosts: str = 'localhost,127.0.0.1,::1,backend'
    mutations_per_minute: int = Field(default=30, ge=1, le=10000)
    voice_webhook_secret: str = ""
    seed_demo_data: bool = False
    mock_voice_delay_seconds: float = Field(default=6, ge=0, le=30)
    scrape_timeout_seconds: float = Field(default=12, ge=2, le=30)
    discovery_timeout_seconds: float = Field(default=100, ge=10, le=180)
    brave_search_api_key: SecretStr | None = None
    groq_api_key: SecretStr | None = None
    groq_model: str = "llama-3.3-70b-versatile"
    gemini_api_key: SecretStr | None = None
    gemini_model: str = "gemini-3.8-flash"
    llm_provider: str = ""

    @property
    def active_llm_provider(self) -> str | None:
        provider = self.llm_provider.strip().lower()
        if provider:
            return provider if provider in {"gemini", "groq"} else None
        if self.gemini_api_key:
            return "gemini"
        if self.groq_api_key:
            return "groq"
        return None

    @property
    def active_llm_model(self) -> str:
        return self.gemini_model if self.active_llm_provider == "gemini" else self.groq_model

    @property
    def active_llm_api_key(self) -> SecretStr | None:
        if self.active_llm_provider == "gemini":
            return self.gemini_api_key
        if self.active_llm_provider == "groq":
            return self.groq_api_key
        return None
    telegram_bot_token: SecretStr | None = None
    telegram_webhook_secret: SecretStr | None = None
    telegram_webhook_url: str = ""
    agent_checkpoint_path: Path = Path(".local/agent-checkpoints.sqlite")
    max_negotiation_rounds: int = Field(default=3, ge=1, le=5)
    llm_timeout_seconds: float = Field(default=20.0, ge=3.0, le=90.0)
    tavily_api_key: SecretStr | None = None
    tavily_extract_timeout_seconds: float = Field(default=18.0, ge=2.0, le=60.0)
    tavily_extract_max_urls_per_task: int = Field(default=5, ge=1, le=20)
    tavily_extract_max_credits_per_task: int = Field(default=4, ge=1, le=20)
    tavily_extract_max_retries: int = Field(default=2, ge=1, le=3)
    tavily_extract_concurrency: int = Field(default=2, ge=1, le=5)
    search_credentials_path: Path = Path('.local/search_credentials.json')

    # Vapi — agente de voz duplex
    vapi_api_key: SecretStr | None = None
    vapi_assistant_id: str = ""
    vapi_phone_number_id: str = ""
    vapi_webhook_url: str = ""  # URL pública HTTPS do /webhook/voice para o Vapi chamar


settings = Settings()
