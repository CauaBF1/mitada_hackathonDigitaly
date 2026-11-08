import asyncio
import json
import hashlib
from datetime import datetime, timezone
import os
import tempfile
from pathlib import Path
from email.utils import parsedate_to_datetime

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
    search_usage: int = Field(default=0, ge=0)
    extract_usage: int = Field(default=0, ge=0)


class UsageAccount(BaseModel):
    current_plan: str
    plan_usage: int = Field(ge=0, strict=True)
    plan_limit: int = Field(ge=0, strict=True)
    paygo_usage: int = Field(ge=0, strict=True)
    paygo_limit: int | None = Field(ge=0, strict=True)
    search_usage: int = Field(default=0, ge=0)
    extract_usage: int = Field(default=0, ge=0)


class TavilyExtraction(BaseModel):
    results: dict[str, str] = Field(default_factory=dict)
    failed: dict[str, str] = Field(default_factory=dict)
    extract_depth: str = 'basic'
    credits_used: int = 0
    request_id: str | None = None


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
    def remaining(self) -> int | None:
        plan = max(0, self.account.plan_limit - self.account.plan_usage)
        if self.account.paygo_limit is None:
            if self.account.current_plan.strip().lower() not in {'free', 'researcher'}:
                return plan if plan > 0 else None
            paygo = 0
        else:
            paygo = max(0, self.account.paygo_limit - self.account.paygo_usage)
        account = plan + paygo
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
    monthly_free_credits: int | None = None
    free_plan: bool | None = None
    capabilities: list[str] = Field(default_factory=lambda: ['search', 'extract'])
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


def check_response(response: httpx.Response, *, context: str = 'search') -> None:
    if response.status_code in {401, 403}:
        raise SearchProviderError('A Tavily recusou a chave. Confira a chave no painel do provedor.', 'invalid_key')
    if response.status_code == 429:
        try:
            detail = response.json()
        except ValueError:
            detail = None
        detail_text = json.dumps(detail, ensure_ascii=False).lower() if detail is not None else ''
        if any(term in detail_text for term in ('insufficient credits', 'credit limit', 'quota exceeded', 'out of credits')):
            raise SearchProviderError('A Tavily informou limite de créditos/quota (HTTP 429). Nenhum plano pago foi ativado.', 'insufficient_credits')
        raise SearchProviderError('Limite de requisições (rate limit) da Tavily atingido (HTTP 429). Nenhum plano pago foi ativado.', 'rate_limit')
    if response.status_code in {432, 433}:
        raise SearchProviderError('Limite de uso ou créditos da Tavily atingido. Nenhum plano pago foi ativado.', 'insufficient_credits')
    if response.status_code != 200:
        if context == 'extract' and 400 <= response.status_code < 500:
            raise SearchProviderError(f'Falha na extração via Tavily (HTTP {response.status_code}).', 'extract_failed')
        raise SearchProviderError(f'A Tavily está indisponível (HTTP {response.status_code}).', 'unavailable')


verified_usage: dict[str, tuple[Usage, str]] = {}
USAGE_CACHE_TTL_SECONDS = 60.0
SEARCH_BUDGET_SECONDS = 30.0
usage_cache: dict[str, tuple[Usage, float]] = {}
usage_reservations: dict[str, int] = {}
search_cooldowns: dict[str, float] = {}
extract_cooldowns: dict[str, float] = {}
usage_cooldowns: dict[str, float] = {}


def _usage_with_reservations(usage: Usage, reservation: int) -> Usage:
    if not reservation:
        return usage
    key_data = usage.key.model_dump()
    account_data = usage.account.model_dump()
    key_data['usage'] += reservation
    plan_remaining = max(0, usage.account.plan_limit - usage.account.plan_usage)
    from_plan = min(reservation, plan_remaining)
    account_data['plan_usage'] += from_plan
    paygo_reserve = reservation - from_plan
    if paygo_reserve and usage.account.paygo_limit is not None:
        account_data['paygo_usage'] += paygo_reserve
    elif paygo_reserve:
        account_data['plan_usage'] += paygo_reserve
    return Usage(key=key_data, account=account_data)


def _reserve_credits(key: SecretStr, credits: int) -> None:
    identity = credential_id(key)
    usage_reservations[identity] = usage_reservations.get(identity, 0) + credits


def cached_usage(key: SecretStr) -> Usage | None:
    identity = credential_id(key)
    cached = usage_cache.get(identity)
    if not cached or asyncio.get_running_loop().time() - cached[1] >= USAGE_CACHE_TTL_SECONDS:
        return None
    return _usage_with_reservations(cached[0], usage_reservations.get(identity, 0))


def _retry_after_seconds(response: httpx.Response) -> float:
    value = response.headers.get('Retry-After')
    if value:
        try:
            return max(0.0, float(value))
        except ValueError:
            try:
                return max(0.0, (parsedate_to_datetime(value) - datetime.now(timezone.utc)).total_seconds())
            except (TypeError, ValueError, OverflowError):
                pass
    return 1.0


def credential_id(key: SecretStr) -> str:
    return hashlib.sha256(key.get_secret_value().encode()).hexdigest()


async def get_usage(client: httpx.AsyncClient, key: SecretStr, *, force: bool = False) -> Usage:
    identity = credential_id(key)
    now = asyncio.get_running_loop().time()
    cached = usage_cache.get(identity)
    cache_valid = cached and now - cached[1] < USAGE_CACHE_TTL_SECONDS
    if cache_valid and (not force or usage_cooldowns.get(identity, 0.0) > now):
        return _usage_with_reservations(cached[0], usage_reservations.get(identity, 0))
    if usage_cooldowns.get(identity, 0.0) > now:
        raise SearchProviderError('Consulta de saldo Tavily em pausa temporária após HTTP 429.', 'rate_limit')
    try:
        async with asyncio.timeout(20):
            for attempt in range(2):
                try:
                    async with asyncio.timeout(9.5):
                        response = await client.get('https://api.tavily.com/usage', headers={'Authorization': f'Bearer {key.get_secret_value()}'}, timeout=9.5)
                    if response.status_code in {502, 503, 504} and attempt == 0:
                        await asyncio.sleep(0.25)
                        continue
                    if response.status_code == 429:
                        usage_cooldowns[identity] = asyncio.get_running_loop().time() + _retry_after_seconds(response)
                    check_response(response)
                    usage = Usage.model_validate(response.json())
                    usage_reservations[identity] = 0
                    usage_cache[identity] = (usage, asyncio.get_running_loop().time())
                    verified_usage[identity] = (usage, datetime.now(timezone.utc).isoformat())
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
    enabled = usage.remaining is None or usage.remaining > 0
    unknown_balance = usage.remaining is None
    return SearchConnection(
        connection_status='verified' if enabled else 'paused', last_verified_at=checked_at or datetime.now(timezone.utc).isoformat(),
        configured=True, verified=True, active_provider='tavily' if enabled else 'paused',
        plan=usage.account.current_plan, credits_remaining=usage.remaining, free_plan=usage.free_plan,
        error_code='quota_unknown' if unknown_balance else None,
        message='Credencial validada; a Tavily aplicará o limite disponível a cada consulta.' if unknown_balance else 'Credencial validada. A coleta de preços depende dos sites consultados.' if enabled else 'Busca pausada: a Tavily informou que não há créditos disponíveis.',
    )


search_lock = asyncio.Lock()


async def tavily_results(query: str) -> list[dict[str, str]] | None:
    key = await run_in_threadpool(saved_key)
    if key is None:
        return None
    identity = credential_id(key)
    async with search_lock:
        now = asyncio.get_running_loop().time()
        cooldown_until = search_cooldowns.get(identity, 0.0)
        if cooldown_until > now:
            raise SearchProviderError('A busca Tavily está em pausa temporária após HTTP 429.', 'rate_limit')
        budget_deadline = now + SEARCH_BUDGET_SECONDS
        async with httpx.AsyncClient(timeout=min(10.0, settings.scrape_timeout_seconds), follow_redirects=False) as client:
            usage = cached_usage(key)
            if usage is not None and usage.remaining is not None and usage.remaining < 1:
                raise SearchProviderError('Créditos Tavily esgotados. A pesquisa foi pausada sem alterar o plano ou ativar cobrança.', 'insufficient_credits')
            for attempt in range(2):
                if asyncio.get_running_loop().time() >= budget_deadline:
                    raise SearchProviderError('A consulta à Tavily excedeu o orçamento total de 30 segundos.', 'timeout')
                current_usage = cached_usage(key)
                if current_usage is not None and current_usage.remaining is not None and current_usage.remaining < 1:
                    raise SearchProviderError('Créditos Tavily esgotados ou reservados nesta tarefa. Nenhum plano ou cobrança foi alterado.', 'insufficient_credits')
                _reserve_credits(key, 1)
                try:
                    async with asyncio.timeout(max(0.1, budget_deadline - asyncio.get_running_loop().time())):
                        response = await client.post('https://api.tavily.com/search', headers={'Authorization': f'Bearer {key.get_secret_value()}'}, json={
                            'query': query[:400], 'topic': 'general', 'search_depth': 'basic', 'auto_parameters': False,
                            'country': 'brazil', 'max_results': 20, 'include_answer': False,
                            'include_raw_content': False, 'include_usage': True,
                        })
                    if response.status_code == 429:
                        wait_seconds = _retry_after_seconds(response)
                        search_cooldowns[identity] = asyncio.get_running_loop().time() + wait_seconds
                        try:
                            check_response(response, context='search')
                        except SearchProviderError as exc:
                            if exc.code != 'rate_limit' or attempt == 1 or wait_seconds >= budget_deadline - asyncio.get_running_loop().time():
                                raise
                            await asyncio.sleep(wait_seconds)
                            search_cooldowns.pop(identity, None)
                            continue
                    check_response(response, context='search')
                    body = response.json()
                    rows = body.get('results')
                    if not isinstance(rows, list):
                        raise SearchProviderError('A Tavily retornou uma resposta de busca inválida.', 'invalid_response')
                    return list({row['url']: {'url': row['url'], 'title': str(row.get('title') or row['url'])[:500], 'description': str(row.get('content') or '')[:2000]} for row in rows if isinstance(row, dict) and isinstance(row.get('url'), str)}.values())
                except SearchProviderError:
                    raise
                except (httpx.TimeoutException, TimeoutError):
                    raise SearchProviderError('A consulta à Tavily excedeu o tempo limite.', 'timeout') from None
                except httpx.ConnectError:
                    raise SearchProviderError('Não foi possível conectar à Tavily para realizar a busca.', 'network') from None
                except (httpx.HTTPError, ValueError):
                    raise SearchProviderError('A consulta à Tavily falhou. Tente novamente mais tarde.', 'unavailable') from None


async def tavily_search(query: str) -> list[str] | None:
    rows = await tavily_results(query)
    return [row['url'] for row in rows] if rows is not None else None


async def tavily_extract(
    urls: list[str],
    *,
    extract_depth: str = 'basic',
    query: str | None = None,
    chunks_per_source: int | None = None,
    fmt: str = 'markdown',
    validate_url=None,
) -> TavilyExtraction | None:
    key = await run_in_threadpool(saved_key)
    if key is None:
        return None
    identity = credential_id(key)
    depth = 'advanced' if extract_depth == 'advanced' else 'basic'
    max_urls = min(20, max(1, settings.tavily_extract_max_urls_per_task))
    candidates = list(dict.fromkeys(u.strip() for u in urls if isinstance(u, str) and u.strip()))[:max_urls]
    if not candidates:
        return TavilyExtraction(extract_depth=depth)

    validated_urls: list[str] = []
    failed_urls: dict[str, str] = {}
    for candidate in candidates:
        if validate_url is not None:
            try:
                await validate_url(candidate)
            except Exception as exc:
                failed_urls[candidate] = str(exc) or 'URL rejeitada pela política SSRF.'
                continue
        validated_urls.append(candidate)

    if not validated_urls:
        raise SearchProviderError(
            next(iter(failed_urls.values()), 'Nenhuma URL pública válida para extração.'),
            'extract_failed',
        )

    if extract_cooldowns.get(identity, 0.0) > asyncio.get_running_loop().time():
        raise SearchProviderError('A extração Tavily está em pausa temporária após HTTP 429.', 'rate_limit')

    credits_per_batch = 2 if depth == 'advanced' else 1
    required_credits = max(1, ((len(validated_urls) - 1) // 5 + 1) * credits_per_batch)
    if required_credits > settings.tavily_extract_max_credits_per_task:
        raise SearchProviderError('Orçamento de créditos por tarefa excedido para extração Tavily.', 'insufficient_credits')

    async with search_lock:
        timeout = max(2.0, min(60.0, float(settings.tavily_extract_timeout_seconds)))
        async with httpx.AsyncClient(timeout=timeout, follow_redirects=False) as client:
            usage = cached_usage(key)
            if usage is not None and usage.remaining is not None and usage.remaining < required_credits:
                raise SearchProviderError('Créditos Tavily insuficientes para esta extração. Nenhum plano ou cobrança foi alterado.', 'insufficient_credits')

            _reserve_credits(key, required_credits)

            payload: dict = {
                'urls': validated_urls,
                'extract_depth': depth,
                'format': 'text' if fmt == 'text' else 'markdown',
                'include_images': False,
                'include_usage': True,
            }
            if query and query.strip():
                payload['query'] = query.strip()[:400]
                if chunks_per_source is not None:
                    payload['chunks_per_source'] = max(1, min(5, int(chunks_per_source)))

            retries = max(1, min(3, int(settings.tavily_extract_max_retries)))
            response: httpx.Response | None = None
            for attempt in range(retries):
                try:
                    async with asyncio.timeout(timeout):
                        response = await client.post(
                            'https://api.tavily.com/extract',
                            headers={'Authorization': f'Bearer {key.get_secret_value()}'},
                            json=payload,
                            timeout=timeout,
                        )
                    # A timeout/5xx may have consumed credits. Do not resubmit
                    # an extraction unless the connection was never established.
                    break
                except (httpx.TimeoutException, TimeoutError):
                    raise SearchProviderError('A extração via Tavily excedeu o tempo limite.', 'timeout') from None
                except httpx.ConnectError:
                    if attempt + 1 >= retries:
                        raise SearchProviderError('Não foi possível conectar à Tavily para extração.', 'network') from None
                    await asyncio.sleep(0.25)
                except httpx.HTTPError:
                    raise SearchProviderError('A extração via Tavily está indisponível no momento.', 'unavailable') from None

            assert response is not None
            if response.status_code == 429:
                extract_cooldowns[identity] = asyncio.get_running_loop().time() + _retry_after_seconds(response)
            check_response(response, context='extract')
            try:
                body = response.json()
            except ValueError:
                raise SearchProviderError('A Tavily retornou uma resposta de extração em formato inválido.', 'extract_failed') from None

            rows = body.get('results')
            failed_rows = body.get('failed_results') or []
            if not isinstance(rows, list) or not isinstance(failed_rows, list):
                raise SearchProviderError('A Tavily retornou estrutura inesperada na extração.', 'extract_failed')

            extracted: dict[str, str] = {}
            for row in rows:
                if not isinstance(row, dict) or not isinstance(row.get('url'), str):
                    continue
                if row['url'] not in validated_urls:
                    failed_urls[row['url']] = 'Origem retornada não corresponde às URLs solicitadas.'
                    continue
                content = str(row.get('raw_content') or '').strip()
                if content:
                    extracted[row['url']] = content
                else:
                    failed_urls[row['url']] = 'Conteúdo extraído vazio.'

            for row in failed_rows:
                if isinstance(row, dict) and isinstance(row.get('url'), str):
                    failed_urls[row['url']] = str(row.get('error') or 'Falha ao extrair URL na Tavily.')

            usage_info = body.get('usage') if isinstance(body.get('usage'), dict) else {}
            credits_used = int(usage_info.get('credits', required_credits if extracted else 0) or 0)
            return TavilyExtraction(
                results=extracted,
                failed=failed_urls,
                extract_depth=depth,
                credits_used=credits_used,
                request_id=str(body.get('request_id')) if body.get('request_id') else None,
            )


router = APIRouter(prefix='/integrations/search', tags=['search'])


@router.get('', response_model=SearchConnection)
async def status():
    key = None
    try:
        key = await run_in_threadpool(saved_key)
        if key is None:
            return SearchConnection(configured=False, active_provider='brave' if settings.brave_search_api_key else 'public', message='Conecte sua chave gratuita Tavily para usar o provedor de busca. A busca pública continua disponível.')
        async with httpx.AsyncClient(timeout=8, follow_redirects=False) as client:
            usage = await get_usage(client, key, force=True)
            return public_status(usage, verified_usage[credential_id(key)][1])
    except SearchProviderError as exc:
        history = verified_usage.get(credential_id(key)) if key else None
        rate_limited = exc.code == 'rate_limit'
        message = 'A consulta de saldo foi limitada pela Tavily; a busca pode continuar disponível com a credencial salva.' if rate_limited else str(exc)
        return SearchConnection(configured=True, active_provider='tavily' if rate_limited else 'paused', connection_status='temporary_failure' if exc.code in {'timeout', 'network', 'rate_limit'} else 'error', error_code=exc.code, message=message, last_verified_at=history[1] if history else None, plan=history[0].account.current_plan if history else None, credits_remaining=history[0].remaining if history else None, balance_is_historical=bool(history))


@router.post('', response_model=SearchConnection)
async def connect(payload: ConnectSearch, request: Request, x_nexo_settings: str | None = Header(default=None)):
    allowed = {value.strip() for value in settings.cors_origins.split(',')}
    if request.headers.get('origin') not in allowed or x_nexo_settings != '1':
        raise HTTPException(403, 'Configure a integração pela página local da aplicação.')
    try:
        async with httpx.AsyncClient(timeout=8, follow_redirects=False) as client:
            usage = await get_usage(client, payload.api_key, force=True)
        await run_in_threadpool(save_key, payload.api_key)
        return public_status(usage, verified_usage[credential_id(payload.api_key)][1])
    except SearchProviderError as exc:
        raise HTTPException(422, str(exc)) from None
    except OSError:
        raise HTTPException(503, 'O backend não conseguiu salvar a credencial. Verifique o diretório de configuração.') from None
