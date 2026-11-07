"""Script simples para testar o disparo de chamada telefônica via Vapi."""
import json
import os
import sys
import urllib.request
import urllib.error
from pathlib import Path
# Carrega o .env da raiz manualmente (sem precisar de pacotes externos)
root = Path(__file__).resolve().parents[1]
env_file = root / ".env"
if env_file.exists():
    for line in env_file.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip())

api_key = os.getenv("VAPI_API_KEY", "").strip()
assistant_id = os.getenv("VAPI_ASSISTANT_ID", "").strip()
phone_number_id = os.getenv("VAPI_PHONE_NUMBER_ID", "").strip()
webhook_url = os.getenv("VAPI_WEBHOOK_URL", "").strip()

if not api_key:
    sys.exit("❌ VAPI_API_KEY não encontrada no .env")
if not assistant_id:
    sys.exit("❌ VAPI_ASSISTANT_ID não encontrada no .env")
if not phone_number_id:
    sys.exit("❌ VAPI_PHONE_NUMBER_ID não encontrada no .env")

if len(sys.argv) < 2:
    print("Uso: python3 scripts/test_call.py +5511999999999 [item] [preco_alvo]")
    print("Exemplo: python3 scripts/test_call.py +5511987654321 'MacBook Pro' 8000")
    sys.exit(1)

dest_number = sys.argv[1].strip()
item = sys.argv[2] if len(sys.argv) > 2 else "Parafuso Sextavado M8"
target_price = sys.argv[3] if len(sys.argv) > 3 else "15.00"

print(f"📞 Iniciando chamada de teste via Vapi:")
print(f"  • Destino: {dest_number}")
print(f"  • Item: {item}")
print(f"  • Preço alvo: R$ {target_price}")
print(f"  • Assistant ID: {assistant_id}")
print(f"  • Phone ID: {phone_number_id}")
if webhook_url:
    print(f"  • Webhook Server: {webhook_url}")

purchase_context = json.dumps({
    "item": item,
    "target_price": str(target_price),
    "requested_qty": 10,
    "currency": "BRL",
    "supplier_name": "Fornecedor Teste",
}, ensure_ascii=False)

payload = {
    "assistantId": assistant_id,
    "phoneNumberId": phone_number_id,
    "customer": {"number": dest_number},
    "metadata": {"test": True},
    "assistantOverrides": {
        "variableValues": {"purchase_context": purchase_context},
    },
}

if webhook_url:
    payload["assistantOverrides"]["server"] = {"url": webhook_url}

data = json.dumps(payload).encode("utf-8")
req = urllib.request.Request(
    "https://api.vapi.ai/call/phone",
    data=data,
    headers={
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "User-Agent": "Nexo-Voice-Test/1.0",
    },
    method="POST",
)

try:
    with urllib.request.urlopen(req, timeout=25) as response:
        res_body = json.loads(response.read().decode("utf-8"))
        print("\n✅ Chamada disparada com sucesso!")
        print(f"  • Call ID: {res_body.get('id')}")
        print(f"  • Status: {res_body.get('status')}")
        print(f"  • Telefone tocando em: {dest_number}")
except urllib.error.HTTPError as e:
    err_body = e.read().decode("utf-8")
    print(f"\n❌ Erro HTTP {e.code} ao disparar chamada:")
    try:
        err_json = json.loads(err_body)
        print(f"  {json.dumps(err_json, indent=2, ensure_ascii=False)}")
    except Exception:
        print(f"  {err_body}")
    sys.exit(1)
except Exception as e:
    print(f"\n❌ Falha de conexão: {e}")
    sys.exit(1)
