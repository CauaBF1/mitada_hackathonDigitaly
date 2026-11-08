#!/usr/bin/env python3
"""Forward only authenticated Evolution WhatsApp webhooks to the local Nest API."""
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
        value = line.strip()
        if not value or value.startswith("#") or "=" not in value:
            continue
        name, contents = value.split("=", 1)
        if name.strip() == key:
            return contents.strip().strip("'\"")
    return ""


MAX_BODY = 65536
TIMEOUT_SECONDS = float(os.environ.get("GATEWAY_TIMEOUT_SECONDS") or _dotenv_value("GATEWAY_TIMEOUT_SECONDS") or "45")
NEST_API_URL = (os.environ.get("NEST_API_URL") or _dotenv_value("NEST_API_URL") or "http://127.0.0.1:4000").rstrip("/")
SECRET = os.environ.get("WHATSAPP_WEBHOOK_SECRET") or _dotenv_value("WHATSAPP_WEBHOOK_SECRET")


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        # Do not include the URL, headers, body, or credentials in access logs.
        return

    def log_event(self, message: str):
        super().log_message("%s", message)

    def do_POST(self):
        if self.path.split("?", 1)[0] != "/webhook/whatsapp":
            return self.reply(404, {"detail": "Not Found"})
        supplied = self.headers.get("X-WhatsApp-Webhook-Secret", "")
        if not SECRET or not supplied or not hmac.compare_digest(supplied, SECRET):
            return self.reply(401, {"detail": "Credencial inválida."})
        try:
            length = int(self.headers.get("Content-Length", "-1"))
        except ValueError:
            length = -1
        if length < 0 or length > MAX_BODY:
            return self.reply(413, {"detail": "Evento excedeu o limite."})
        body = self.rfile.read(length)
        request = Request(NEST_API_URL + "/webhook/whatsapp", data=body, method="POST", headers={
            "Content-Type": self.headers.get("Content-Type", "application/json"),
            "X-WhatsApp-Webhook-Secret": supplied,
        })
        try:
            with urlopen(request, timeout=TIMEOUT_SECONDS) as response:
                payload, status = response.read(MAX_BODY + 1), response.status
        except HTTPError as error:
            payload, status = error.read(MAX_BODY + 1), error.code
            self.log_event(f"webhook_forward status={status}")
        except TimeoutError:
            self.log_event("webhook_forward error=upstream_timeout")
            return self.reply(503, {"detail": "API temporariamente indisponível.", "code": "upstream_timeout"})
        except URLError as error:
            reason = getattr(error, "reason", None)
            reason_name = type(reason).__name__ if reason is not None else type(error).__name__
            self.log_event(f"webhook_forward error=upstream_unreachable reason={reason_name}")
            return self.reply(503, {"detail": "API temporariamente indisponível.", "code": "upstream_unreachable"})
        if len(payload) > MAX_BODY:
            return self.reply(502, {"detail": "Resposta da API excedeu o limite."})
        try:
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
        except (BrokenPipeError, ConnectionResetError):
            self.log_event(f"webhook_forward warn=client_disconnected status={status}")

    def do_GET(self):
        self.reply(404, {"detail": "Not Found"})

    def reply(self, status: int, data: dict):
        payload = json.dumps(data).encode()
        try:
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
        except (BrokenPipeError, ConnectionResetError):
            pass


if __name__ == "__main__":
    host = os.environ.get("WHATSAPP_GATEWAY_HOST") or _dotenv_value("WHATSAPP_GATEWAY_HOST") or "127.0.0.1"
    port = int(os.environ.get("WHATSAPP_GATEWAY_PORT") or _dotenv_value("WHATSAPP_GATEWAY_PORT") or "8082")
    ThreadingHTTPServer((host, port), Handler).serve_forever()
