"""Isolated test server: controlled external responses, never a production mode."""
import argparse
import asyncio
import json
import os
import sys
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('--data-dir', required=True)
parser.add_argument('--port', type=int, default=8001)
args = parser.parse_args()
root = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(root))
directory = Path(args.data_dir).resolve()
directory.mkdir(parents=True, exist_ok=True)
os.environ.update(DATABASE_URL='sqlite:///' + str(directory / 'scenario.db'), AGENT_CHECKPOINT_PATH=str(directory / 'checkpoints.sqlite'), GROQ_API_KEY='test-only', TELEGRAM_BOT_TOKEN='test-only', TELEGRAM_WEBHOOK_SECRET='controlled-webhook-secret', MY_TELEGRAM_CHAT_ID='555123', CORS_ORIGINS='http://127.0.0.1:3100,http://localhost:3000', ALLOWED_HOSTS='127.0.0.1,localhost,testserver', MUTATIONS_PER_MINUTE='10000', TAVILY_API_KEY='', BRAVE_SEARCH_API_KEY='', SEARCH_CREDENTIALS_PATH=str(directory / 'credentials.json'), LANGSMITH_TRACING='false')

from decimal import Decimal
from sqlalchemy import func, select
from app import agent, messaging, main
from app.agent_intelligence import DiscoveryPlan, MemoryProfile, NegotiatorResponse, TacticalSummary, AuditorResponse
from app.database import SessionLocal, SupplierMemory, ChatMessage
from app.scraper_tools import Discovery, Reputation, parse_product, timestamp
from app.commercial import ACCEPTED, AdditionalCost, monetary_values, postal_code

DOMAINS = ('example.com', 'example.org', 'example.net')

async def discovery(item, progress=None):
    products = []
    for index, host in enumerate(DOMAINS):
        html = '<h1>' + item + '</h1><script type="application/ld+json">' + json.dumps({'@type': 'Product', 'name': item, 'offers': {'@type': 'Offer', 'price': str(100 + 5 * index), 'priceCurrency': 'BRL', 'availability': 'https://schema.org/InStock', 'seller': {'name': f'FORNECEDOR CONTROLADO {index}'}}}) + '</script>'
        row = parse_product(html, f'https://{host}/test-product', item)
        products.append(row.model_copy(update={'shipping_fee': Decimal('0'), 'shipping_scope': 'BR', 'additional_costs': []}))
    result = Discovery(products=products, query=item, searched_at=timestamp())
    if progress:
        await progress(result)
    return result

async def reputation(name, supplier):
    return Reputation(supplier_domain=supplier.supplier_domain, score=Decimal('8'), verified=True, approved=True, reason='RESPOSTA CONTROLADA DE TESTE; não é nota real.', checked_at=timestamp())

async def resolve():
    return 'controlled-test-model'

async def telegram(method, payload):
    if method == 'sendMessage':
        with SessionLocal() as db:
            identity = (db.scalar(select(func.max(ChatMessage.telegram_message_id)).where(ChatMessage.sender_type == 'AI')) or 100) + 1
        await asyncio.sleep(0.02)
        return {'message_id': identity}
    if method == 'getWebhookInfo':
        return {'url': '', 'pending_update_count': 0}
    return {'username': 'controlled_test_bot'}

async def plan(model, data):
    return DiscoveryPlan.model_validate(data['validated_plan']).model_copy(update={'discovery_justification': 'TESTE CONTROLADO: meta calculada com a menor referência e custos explicitamente definidos na fixture.'})

async def memory(model, data):
    return MemoryProfile(**data['validated_statistics'], tactical_briefing='- Histórico confirmado neste banco de teste.\n- Explorar redução de frete já concedida anteriormente.')

async def compose(model, data):
    profile = data.get('supplier_memory_context')
    history = isinstance(profile, dict) and profile.get('has_previous_history')
    text = 'Olá, sou Roberto. Confirma preço unitário em reais, quantidade, frete para CEP 01001-000, taxas adicionais, prazo e pagamento?'
    if data['phase'] != 'initial':
        text = 'Pelo histórico de concessões, consegue frete grátis para CEP 01001-000?' if history else f"Consegue R$ {data['target_total']} no total com frete e taxas, confirmando os termos para CEP 01001-000?"
    (directory / 'last-negotiator-context.json').write_text(json.dumps(data, default=str, ensure_ascii=False))
    return NegotiatorResponse(raciocinio_tatico=TacticalSummary(**data['validated_tactical_summary'], estrategia_aplicada='FRETE_GRATIS' if history else 'DESCONTO_VOLUME'), mensagem_telegram=text)

async def interpret(model, history, memory):
    import re
    msg = history[-1]
    text = msg['text']
    prices = monetary_values(text, 'price')
    freight = monetary_values(text, 'shipping_fee')
    quantity = re.search(r'(\d+)\s*unidades?', text)
    days = re.search(r'(\d+)\s*dias?', text)
    fees = [AdditionalCost(description=name, amount=value.replace(',', '.')) for name, value in re.findall(r'(Seguro|Embalagem)\s+R\$\s*(\d+(?:[.,]\d+)?)', text, re.I)]
    fields = ['price', 'shipping_fee', 'currency', 'available_qty', 'delivery_days', 'conditions', 'additional_costs', 'acceptance', 'delivery_location']
    return agent.ParsedReply(price=min(prices) if prices else None, shipping_fee=min(freight) if freight else '0' if 'frete grátis' in text else None, currency='BRL', available_qty=int(quantity[1]) if quantity else None, delivery_days=int(days[1]) if days else None, conditions='Pix' if 'Pix' in text else None, firm_offer=True, refused=False, additional_costs=fees if fees or 'sem taxas adicionais' in text else None, agreement_confirmed=bool(ACCEPTED.search(text)), delivery_location=postal_code(text), evidence=[agent.TermEvidence(field=field,message_id=msg['id'],quote=text) for field in fields])

async def audit(model, data):
    return AuditorResponse(**{key: data['validated_audit'][key] for key in AuditorResponse.model_fields})

initialize = main.initialize_database

def initialize_database():
    initialize()
    with SessionLocal.begin() as db:
        for index, domain in enumerate(DOMAINS):
            if not db.get(SupplierMemory, domain):
                db.add(SupplierMemory(domain=domain, name='CONTATO DE TESTE', chat_id=555123 + index, authorized_at=timestamp()))

main.initialize_database = initialize_database
agent.search_market, agent.check_reputation, agent.resolve_model = discovery, reputation, resolve
agent.discovery_intelligence, agent.memory_intelligence = plan, memory
agent.negotiator_intelligence, agent.interpret, agent.auditor_intelligence = compose, interpret, audit
messaging.telegram = telegram

if __name__ == '__main__':
    import uvicorn
    uvicorn.run(main.app, host='127.0.0.1', port=args.port, log_level='warning')
