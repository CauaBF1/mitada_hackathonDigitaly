import asyncio
import json
import hashlib
from datetime import datetime, timezone
import os
import tempfile
from pathlib import Path

import httpx
from fastapi import APIRouter, Header, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field, SecretStr, ValidationError, field_validator
from starlette.concurrency import run_in_threadpool

from .config import settings


class SearchProviderError(Exception):
    def __init__(self, message: str, code: str = "provider_error"):
        super().__init__(message)
        self.code = code


class UsageKey(BaseModel):
    usage: int = Field(ge=0, strict=True)
    limit: int | None = Field(default=None, ge=0, strict=True)


class UsageAccount(BaseModel):
    current_plan: str
    plan_usage: int = Field(ge=0, strict=True)
    plan_limit: int = Field(ge=0, strict=True)
    paygo_usage: int = Field(ge=0, strict=True)
    paygo_limit: int | None = Field(ge=0, strict=True)


class Usage(BaseModel):
    key: UsageKey
    account: UsageAccount

    @property
    def free_plan(self) -> bool:
        return (
            self.account.current_plan.strip().lower() in {'free', 'researcher'}
            and self.account.paygo_limit in {None, 0}
            and self.account.paygo_usage == 0
        )

    @property
    def remaining(self) -> int:
        limit = min(1000, self.account.plan_limit)
        account = max(0, limit - self.account.plan_usage)
        key = max(0, self.key.limit - self.key.usage) if self.key.limit is not None else account
        return min(account, key)


class SearchConnection(BaseModel):
    connection_status: str = 'unconfigured'
    last_verified_at: str | None = None
    error_code: str | None = None
    balance_is_historical: bool = False
    provider: str = 'tavily'
    configured: bool
    verified: bool = False
    active_provider: str
    plan: str | None = None
    credits_remaining: int | None = None
    monthly_free_credits: int = 1000
    free_plan: bool | None = None
    message: str
    signup_url: str = 'https://app.tavily.com'
    pricing_url: str = 'https://docs.tavily.com/documentation/api-credits'


class ConnectSearch(BaseModel):
    model_config = ConfigDict(extra='forbid')
    api_key: SecretStr

    @field_validator('api_key')
    @classmethod
    def validate_key(cls, value):
        token = value.get_secret_value().strip()
        if not token.startswith('tvly-') or not 12 <= len(token) <= 256 or any(char.isspace() for char in token):
            raise ValueError('Informe uma chave Tavily válida.')
        return SecretStr(token)


def saved_key() -> SecretStr | None:
    path = settings.search_credentials_path
    if path.exists():
        try:
            data = json.loads(path.read_text(encoding='utf-8'))
            return ConnectSearch.model_validate(data).api_key
        except (OSError, ValueError, ValidationError):
            raise SearchProviderError('Não foi possível ler a credencial de busca salva.') from None
    return settings.tavily_api_key if settings.tavily_api_key and settings.tavily_api_key.get_secret_value() else None


def save_key(key: SecretStr) -> None:
    path = settings.search_credentials_path
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    descriptor, temporary = tempfile.mkstemp(prefix='.search-', dir=path.parent)
    try:
        with os.fdopen(descriptor, 'w', encoding='utf-8') as file:
            json.dump({'api_key': key.get_secret_value()}, file)
            file.flush()
            os.fsync(file.fileno())
        os.chmod(temporary, 0o600)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def check_response(response: httpx.Response) -> None:
    if response.status_code == 401:
        raise SearchProviderError('A Tavily recusou a chave. Confira a chave no painel do provedor.', 'invalid_key')
    if response.status_code in {429, 432, 433}:
        raise SearchProviderError('Limite de uso ou créditos da Tavily atingido. Nenhum plano pago foi ativado.')
    if response.status_code != 200:
        raise SearchProviderError(f'A Tavily está indisponível (HTTP {response.status_code}).')


verified_usage: dict[str, tuple[Usage, str]] = {}


def credential_id(key: SecretStr) -> str:
    return hashlib.sha256(key.get_secret_value().encode()).hexdigest()


async def get_usage(client: httpx.AsyncClient, key: SecretStr) -> Usage:
    try:
        async with asyncio.timeout(20):
            for attempt in range(2):
                try:
                    async with asyncio.timeout(9.5):
                        response = await client.get('https://api.tavily.com/usage', headers={'Authorization': f'Bearer {key.get_secret_value()}'}, timeout=9.5)
                    if response.status_code in {502, 503, 504} and attempt == 0:
                        await asyncio.sleep(0.25)
                        continue
                    check_response(response)
                    usage = Usage.model_validate(response.json())
                    verified_usage[credential_id(key)] = (usage, datetime.now(timezone.utc).isoformat())
                    return usage
                except (httpx.TimeoutException, httpx.ConnectError, TimeoutError):
                    if attempt:
                        raise
                    await asyncio.sleep(0.25)
    except (httpx.TimeoutException, TimeoutError):
        raise SearchProviderError('Não foi possível confirmar o saldo dentro do prazo. Sua chave continua salva, se já configurada. Tente novamente.', 'timeout') from None
    except httpx.HTTPError:
        raise SearchProviderError('Não foi possível acessar a Tavily. Verifique a conexão de rede do backend.', 'network') from None
    except (ValueError, ValidationError):
        raise SearchProviderError('A Tavily retornou dados de saldo ou plano em um formato inesperado.', 'invalid_response') from None


def public_status(usage: Usage, checked_at: str | None = None) -> SearchConnection:
    enabled = usage.free_plan and usage.remaining > 0
    return SearchConnection(
        connection_status='verified' if enabled else 'paused', last_verified_at=checked_at or datetime.now(timezone.utc).isoformat(),
        configured=True, verified=True, active_provider='tavily' if enabled else 'paused',
        plan=usage.account.current_plan, credits_remaining=usage.remaining, free_plan=usage.free_plan,
        message='Credencial validada. A coleta de preços depende dos sites consultados.' if enabled else 'Busca pausada: use o plano gratuito sem pay-as-you-go e com créditos disponíveis.',
    )


search_lock = asyncio.Lock()


async def tavily_results(query: str) -> list[dict[str, str]] | None:
    key = await run_in_threadpool(saved_key)
    if key is None:
        return None
    async with search_lock:
        async with httpx.AsyncClient(timeout=settings.scrape_timeout_seconds, follow_redirects=False) as client:
            usage = await get_usage(client, key)
            if not usage.free_plan:
                raise SearchProviderError('A integração permite apenas o plano gratuito Researcher/Free, com pay-as-you-go desativado.')
            if usage.remaining < 1:
                raise SearchProviderError('Créditos gratuitos esgotados. A pesquisa foi pausada sem ativar cobrança.')
            try:
                response = await client.post('https://api.tavily.com/search', headers={'Authorization': f'Bearer {key.get_secret_value()}'}, json={
                    'query': query, 'topic': 'general', 'search_depth': 'basic', 'auto_parameters': False,
                    'country': 'brazil', 'max_results': 20, 'include_answer': False,
                    'include_raw_content': False, 'include_usage': True,
                })
                check_response(response)
                body = response.json()
                rows = body.get('results')
                if not isinstance(rows, list):
                    raise SearchProviderError('A Tavily retornou uma resposta de busca inválida.')
                return list({row['url']: {'url': row['url'], 'title': str(row.get('title') or row['url'])[:500], 'description': str(row.get('content') or '')[:2000]} for row in rows if isinstance(row, dict) and isinstance(row.get('url'), str)}.values())
            except (httpx.HTTPError, ValueError):
                raise SearchProviderError('A consulta à Tavily falhou. Tente novamente mais tarde.') from None


async def tavily_search(query: str) -> list[str] | None:
    rows = await tavily_results(query)
    return [row['url'] for row in rows] if rows is not None else None


router = APIRouter(prefix='/integrations/search', tags=['search'])


@router.get('', response_model=SearchConnection)
async def status():
    key = None
    try:
        key = await run_in_threadpool(saved_key)
        if key is None:
            return SearchConnection(configured=False, active_provider='brave' if settings.brave_search_api_key else 'public', message='Conecte sua chave gratuita Tavily para usar o provedor de busca. A busca pública continua disponível.')
        async with httpx.AsyncClient(timeout=8, follow_redirects=False) as client:
            usage = await get_usage(client, key)
            return public_status(usage, verified_usage[credential_id(key)][1])
    except SearchProviderError as exc:
        history = verified_usage.get(credential_id(key)) if key else None
        return SearchConnection(configured=True, active_provider='paused', connection_status='temporary_failure' if exc.code in {'timeout', 'network'} else 'error', error_code=exc.code, message=str(exc), last_verified_at=history[1] if history else None, plan=history[0].account.current_plan if history else None, credits_remaining=history[0].remaining if history else None, balance_is_historical=bool(history))


@router.post('', response_model=SearchConnection)
async def connect(payload: ConnectSearch, request: Request, x_nexo_settings: str | None = Header(default=None)):
    allowed = {value.strip() for value in settings.cors_origins.split(',')}
    if request.headers.get('origin') not in allowed or x_nexo_settings != '1':
        raise HTTPException(403, 'Configure a integração pela página local da aplicação.')
    try:
        async with httpx.AsyncClient(timeout=8, follow_redirects=False) as client:
            usage = await get_usage(client, payload.api_key)
        if not usage.free_plan:
            raise HTTPException(422, 'Use uma chave do plano gratuito Researcher/Free com pay-as-you-go desativado.')
        await run_in_threadpool(save_key, payload.api_key)
        return public_status(usage, verified_usage[credential_id(payload.api_key)][1])
    except SearchProviderError as exc:
        raise HTTPException(422, str(exc)) from None
    except OSError:
        raise HTTPException(503, 'O backend não conseguiu salvar a credencial. Verifique o diretório de configuração.') from None
