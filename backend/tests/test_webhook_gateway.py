import httpx
from fastapi.testclient import TestClient
from app.webhook_gateway import app


def test_gateway_exposes_only_authenticated_webhook():
    with TestClient(app) as client:
        for path in ('/', '/docs', '/openapi.json', '/chat/1', '/godmode/dashboard', '/integrations/agent'):
            assert client.get(path).status_code == 404
        assert client.post('/webhook/telegram', json={'update_id': 1}).status_code == 401
        assert client.post('/webhook/telegram', json={'update_id': 1}, headers={'X-Telegram-Bot-Api-Secret-Token': 'wrong'}).status_code == 401
        assert client.get('/webhook/telegram').status_code == 405
        assert client.post('/webhook/telegram', content='x' * 65537, headers={'X-Telegram-Bot-Api-Secret-Token': 'test-telegram-secret'}).status_code == 413


def test_gateway_forwards_to_fixed_local_route_and_preserves_status():
    seen = []
    def handler(request):
        seen.append(str(request.url))
        assert request.headers['X-Telegram-Bot-Api-Secret-Token'] == 'test-telegram-secret'
        return httpx.Response(200, json={'ok': True})
    with TestClient(app) as client:
        app.state.client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        response = client.post('/webhook/telegram', json={'update_id': 1}, headers={'X-Telegram-Bot-Api-Secret-Token': 'test-telegram-secret'})
        assert response.json() == {'ok': True}
        assert seen == ['http://127.0.0.1:8000/webhook/telegram']
        client.portal.call(app.state.client.aclose)
