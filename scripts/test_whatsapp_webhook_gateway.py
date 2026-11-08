import importlib.util
import json
import threading
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen

MODULE_PATH = Path(__file__).with_name('whatsapp_webhook_gateway.py')
spec = importlib.util.spec_from_file_location('whatsapp_webhook_gateway', MODULE_PATH)
gateway = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gateway)


class Reply:
    status = 202

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False

    def read(self, _limit):
        return b'{"ok":true}'


class GatewayTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(('127.0.0.1', 0), gateway.Handler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.base = f'http://127.0.0.1:{cls.server.server_port}'

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=2)

    def post(self, path, body=b'{}', secret='secret'):
        request = Request(self.base + path, data=body, method='POST', headers={
            'Content-Type': 'application/json', 'X-WhatsApp-Webhook-Secret': secret,
        })
        try:
            return urlopen(request)
        except HTTPError as error:
            error.read()
            return error

    def test_only_webhook_path_and_valid_secret_forward(self):
        gateway.SECRET = 'secret'
        with patch.object(gateway, 'urlopen', return_value=Reply()) as forward:
            wrong_path = self.post('/instance/create')
            self.assertEqual(wrong_path.code, 404)
            unauthorized = self.post('/webhook/whatsapp', secret='wrong')
            self.assertEqual(unauthorized.code, 401)
            response = self.post('/webhook/whatsapp', b'{"event":"messages.upsert"}')
            self.assertEqual(response.status, 202)
            self.assertEqual(json.loads(response.read()), {'ok': True})
            self.assertEqual(forward.call_count, 1)
            forwarded = forward.call_args.args[0]
            self.assertEqual(forwarded.full_url, gateway.NEST_API_URL + '/webhook/whatsapp')
            self.assertEqual(forwarded.get_header('X-whatsapp-webhook-secret'), 'secret')

    def test_body_limit_rejects_before_forward(self):
        gateway.SECRET = 'secret'
        with patch.object(gateway, 'urlopen') as forward:
            oversized = self.post('/webhook/whatsapp', b'x' * (gateway.MAX_BODY + 1))
            self.assertEqual(oversized.code, 413)
            forward.assert_not_called()


if __name__ == '__main__':
    unittest.main()
