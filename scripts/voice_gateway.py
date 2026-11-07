"""Servidor leve de webhook para Vapi e encaminhamento para o Telegram (100% Python stdlib)."""
import json
import logging
import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import urllib.request
import urllib.error

# Carrega .env da raiz
root = Path(__file__).resolve().parents[1]
env_file = root / ".env"
if env_file.exists():
    for line in env_file.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip())

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("voice_gateway")

PORT = 8000
TELEGRAM_BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN", "").strip()
TELEGRAM_ALLOWED_CHAT_IDS = [
    c.strip() for c in os.getenv("TELEGRAM_ALLOWED_CHAT_IDS", "").split(",") if c.strip()
]
MY_TELEGRAM_CHAT_ID = os.getenv("MY_TELEGRAM_CHAT_ID", "").strip()
if MY_TELEGRAM_CHAT_ID and MY_TELEGRAM_CHAT_ID not in TELEGRAM_ALLOWED_CHAT_IDS:
    TELEGRAM_ALLOWED_CHAT_IDS.append(MY_TELEGRAM_CHAT_ID)


def send_telegram(text: str) -> bool:
    """Envia mensagem no Telegram para todos os chats autorizados."""
    if not TELEGRAM_BOT_TOKEN or not TELEGRAM_ALLOWED_CHAT_IDS:
        logger.warning("Telegram token ou chat IDs não configurados no .env")
        return False
    success = False
    for chat_id in TELEGRAM_ALLOWED_CHAT_IDS:
        try:
            url = f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendMessage"
            payload = json.dumps({"chat_id": chat_id, "text": text}).encode("utf-8")
            req = urllib.request.Request(
                url, data=payload, headers={"Content-Type": "application/json"}
            )
            with urllib.request.urlopen(req, timeout=10) as resp:
                if resp.status == 200:
                    logger.info("✅ Mensagem Telegram enviada com sucesso para %s", chat_id)
                    success = True
        except Exception as e:
            logger.error("Falha ao enviar Telegram para %s: %s", chat_id, e)
    return success


class VapiWebhookHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path in ("/", "/health"):
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b'{"status":"ok","service":"nexo-voice-gateway"}')
            return
        self.send_response(404)
        self.end_headers()

    def do_POST(self):
        if not self.path.startswith("/webhook/voice"):
            self.send_response(404)
            self.end_headers()
            return

        content_length = int(self.headers.get("Content-Length", 0))
        raw_body = self.rfile.read(content_length).decode("utf-8")
        try:
            payload = json.loads(raw_body)
        except Exception:
            self.send_response(400)
            self.end_headers()
            return

        logger.info("📩 Webhook Vapi recebido! Tipo: %s", payload.get("message", {}).get("type", "unknown"))

        message = payload.get("message", {})
        msg_type = message.get("type")

        # 1. Trata tool-calls (quando a IA chama submit_procurement_quote ao vivo)
        if msg_type == "tool-calls":
            tool_calls = message.get("toolCallList", [])
            results = []
            for tool in tool_calls:
                func = tool.get("function", {})
                args = func.get("arguments", {})
                if isinstance(args, str):
                    try:
                        args = json.loads(args)
                    except Exception:
                        pass
                logger.info("🛠️ Tool executada: %s com dados: %s", func.get("name"), args)
                results.append({
                    "name": func.get("name"),
                    "toolCallId": tool.get("id"),
                    "result": json.dumps({"status": "recorded", "message": "Cotação registrada com sucesso!"}),
                })
            response_data = json.dumps({"results": results}).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(response_data)
            return

        # 2. Trata end-of-call-report (quando a chamada é finalizada)
        if msg_type == "end-of-call-report":
            # Extrai a cotação registrada
            artifact = message.get("artifact", {})
            summary = message.get("analysis", {}).get("summary", "")
            transcript = artifact.get("transcript", "")

            # Busca cotação nos toolCalls do artifact
            quote = None
            for m in artifact.get("messages", []):
                for tc in m.get("toolCalls", []):
                    f = tc.get("function", {})
                    if f.get("name") == "submit_procurement_quote":
                        a = f.get("arguments", {})
                        quote = json.loads(a) if isinstance(a, str) else a

            # Monta texto para o Telegram
            if quote:
                tg_text = (
                    "✅ Ligação concluída com sucesso!\n\n"
                    "📋 Cotação registrada pelo assistente de voz:\n"
                    f"• Preço unitário: R$ {quote.get('final_price', 'N/A')}\n"
                    f"• Preço inicial: R$ {quote.get('initial_price', 'N/A')}\n"
                    f"• Prazo de entrega: {quote.get('delivery_time', 'N/A')}\n"
                    f"• Quantidade: {quote.get('qty', quote.get('available_qty', 'N/A'))} un.\n"
                    f"• Condições: {quote.get('conditions', 'N/A')}\n"
                    f"• Rodadas de negociação: {quote.get('negotiation_rounds', 0)}\n\n"
                    "Acesse o painel Nexo para revisar e aprovar."
                )
            else:
                tg_text = (
                    "📞 Ligação finalizada!\n\n"
                    f"Resumo da conversa:\n{summary if summary else 'Chamada de teste via web concluída.'}\n"
                )

            logger.info("🚀 Enviando notificação pós-chamada para o Telegram...")
            send_telegram(tg_text)

            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b'{"status":"completed"}')
            return

        # Outros eventos: status-update, speech-update, etc.
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(b'{"status":"ok"}')


def run():
    server = ThreadingHTTPServer(("0.0.0.0", PORT), VapiWebhookHandler)
    logger.info("🎧 Nexo Voice Webhook Gateway rodando na porta %d...", PORT)
    server.serve_forever()


if __name__ == "__main__":
    run()
