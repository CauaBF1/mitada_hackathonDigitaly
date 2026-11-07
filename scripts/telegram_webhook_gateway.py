#!/usr/bin/env python3
"""Expose only the authenticated Telegram webhook path to a local Nest API."""
import hmac
import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


def _dotenv_value(key: str) -> str:
    env_file = Path(__file__).resolve().parents[1] / ".env"
    if not env_file.is_file():
        return ""
    for line in env_file.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        k, v = stripped.split("=", 1)
        if k.strip() == key:
            return v.strip().strip("'\"")
    return ""


MAX_BODY = 65536
NEST_API_URL = (os.environ.get("NEST_API_URL") or _dotenv_value("NEST_API_URL") or "http://127.0.0.1:4000").rstrip("/")
SECRET = os.environ.get("TELEGRAM_WEBHOOK_SECRET") or _dotenv_value("TELEGRAM_WEBHOOK_SECRET")


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        # Avoid logging headers or request bodies that may contain credentials.
        super().log_message("%s", fmt.split("%", 1)[0])

    def do_POST(self):
        if self.path != "/webhook/telegram":
            return self.reply(404, {"detail": "Not Found"})
        supplied = self.headers.get("X-Telegram-Bot-Api-Secret-Token", "")
        if not SECRET or not supplied or not hmac.compare_digest(supplied, SECRET):
            return self.reply(401, {"detail": "Credencial inválida."})
        try:
            length = int(self.headers.get("Content-Length", "-1"))
        except ValueError:
            length = -1
        if length < 0 or length > MAX_BODY:
            return self.reply(413, {"detail": "Atualização excedeu o limite."})
        body = self.rfile.read(length)
        request = Request(NEST_API_URL + "/webhook/telegram", data=body, method="POST", headers={
            "Content-Type": self.headers.get("Content-Type", "application/json"),
            "X-Telegram-Bot-Api-Secret-Token": supplied,
        })
        try:
            with urlopen(request, timeout=40) as response:
                payload, status = response.read(MAX_BODY + 1), response.status
        except HTTPError as error:
            payload, status = error.read(MAX_BODY + 1), error.code
        except (URLError, TimeoutError):
            return self.reply(503, {"detail": "API temporariamente indisponível."})
        if len(payload) > MAX_BODY:
            return self.reply(502, {"detail": "Resposta da API excedeu o limite."})
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self):
        self.reply(404, {"detail": "Not Found"})

    def reply(self, status, data):
        payload = json.dumps(data).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)


if __name__ == "__main__":
    ThreadingHTTPServer((os.environ.get("GATEWAY_HOST", "127.0.0.1"), int(os.environ.get("GATEWAY_PORT", "8081"))), Handler).serve_forever()
