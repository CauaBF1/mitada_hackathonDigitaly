import secrets
from contextlib import asynccontextmanager

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse

from .config import settings


@asynccontextmanager
async def lifespan(app: FastAPI):
    async with httpx.AsyncClient(timeout=15, follow_redirects=False) as client:
        app.state.client = client
        yield


app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None, lifespan=lifespan)


@app.post('/webhook/telegram')
async def telegram_webhook(request: Request):
    secret = settings.telegram_webhook_secret
    supplied = request.headers.get('X-Telegram-Bot-Api-Secret-Token', '')
    if not secret:
        raise HTTPException(503, 'Webhook não configurado.')
    if not supplied or not secrets.compare_digest(supplied.encode(), secret.get_secret_value().encode()):
        raise HTTPException(401, 'Credencial inválida.')
    body = bytearray()
    async for chunk in request.stream():
        body.extend(chunk)
        if len(body) > 65536:
            raise HTTPException(413, 'Atualização excedeu o limite.')
    try:
        response = await request.app.state.client.post('http://127.0.0.1:8000/webhook/telegram', content=bytes(body), headers={'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': supplied})
        return JSONResponse(response.json(), status_code=response.status_code)
    except (httpx.HTTPError, ValueError):
        raise HTTPException(503, 'Backend temporariamente indisponível.') from None
