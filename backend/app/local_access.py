import time
from collections import OrderedDict, deque

from starlette.responses import JSONResponse

from .config import settings


class LocalAccess:
    def __init__(self, app):
        self.app = app
        self.windows = OrderedDict()

    async def __call__(self, scope, receive, send):
        if scope['type'] != 'http':
            return await self.app(scope, receive, send)
        headers = {key.decode().lower(): value.decode() for key, value in scope['headers']}
        host = headers.get('host', '').split(':')[0]
        if headers.get('host', '').startswith('[::1]'):
            host = '::1'
        allowed = {h.strip() for h in settings.allowed_hosts.split(',')}
        error = None
        if host not in allowed:
            error = (403, 'Host não autorizado para esta aplicação local.')
        origin = headers.get('origin')
        if origin and origin not in {v.strip() for v in settings.cors_origins.split(',')}:
            error = (403, 'Origem não autorizada.')
        if error:
            return await JSONResponse({'detail': error[1]}, status_code=error[0])(scope, receive, send)
        if scope['method'] == 'POST':
            identity = ((scope.get('client') or ('unknown',))[0], scope['path'] == '/webhook/telegram')
            now = time.monotonic()
            window = self.windows.setdefault(identity, deque())
            self.windows.move_to_end(identity)
            while window and window[0] < now - 60:
                window.popleft()
            limit = 300 if identity[1] else settings.mutations_per_minute
            if len(window) >= limit:
                return await JSONResponse({'detail': 'Limite de solicitações atingido; tente novamente em um minuto.'}, status_code=429, headers={'Retry-After': '60'})(scope, receive, send)
            window.append(now)
            while len(self.windows) > 512:
                self.windows.popitem(last=False)
            body = bytearray()
            while True:
                event = await receive()
                if event['type'] == 'http.disconnect':
                    return
                body.extend(event.get('body', b''))
                if len(body) > 65536:
                    return await JSONResponse({'detail': 'Requisição excede 64 KiB.'}, status_code=413)(scope, receive, send)
                if not event.get('more_body'):
                    break
            delivered = False
            async def replay():
                nonlocal delivered
                if not delivered:
                    delivered = True
                    return {'type': 'http.request', 'body': bytes(body), 'more_body': False}
                return await receive()
            return await self.app(scope, replay, send)
        return await self.app(scope, receive, send)
