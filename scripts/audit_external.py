"""Read-only integration probes; never sends Telegram messages or changes webhooks."""
import asyncio
import argparse
import json
import logging
import sys
from pathlib import Path

root = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(root / 'backend'))
from app.agent import can_accept, grounded_offer, interpret, resolve_model
from app.messaging import telegram
from app.scraper_tools import timestamp
from app.tools import search_market, check_reputation
import httpx

logging.disable(logging.CRITICAL)

async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--skip-market', action='store_true')
    args = parser.parse_args()
    result = {'checked_at': timestamp(), 'telegram_messages_sent': 0}
    path = root / 'artifacts/final/external.json'
    if args.skip_market and path.exists():
        previous = json.loads(path.read_text())
        for key in ('market', 'reputation', 'market_error_type'):
            if key in previous: result[key] = previous[key]
        result['market_checked_at'] = previous.get('market_checked_at', previous['checked_at'])
    try:
        model = await resolve_model()
        message = 'Confirmo R$ 80 cada, 100 unidades, frete R$ 40, Seguro R$ 10, 5 dias úteis, Pix, CEP 01001-000'
        history = [{'id': 1, 'sender': 'SUPPLIER', 'text': message}]
        parsed = grounded_offer(await interpret(model, history, 'Sem histórico; entrada controlada de teste.'), history)
        result['groq'] = {'model_used': model, 'controlled_input_real_api': True, 'validated_offer': parsed.model_dump(mode='json'), 'accepted_by_backend': can_accept({'quantity': 100, 'target': '8500', 'delivery_location': '01001-000'}, parsed)}
    except Exception as error:
        result['groq'] = {'error_type': type(error).__name__}
    try:
        bot = await telegram('getMe', {})
        webhook = await telegram('getWebhookInfo', {})
        result['telegram'] = {'bot_identity_valid': bool(bot.get('is_bot')), 'webhook_configured': bool(webhook.get('url')), 'pending_update_count': webhook.get('pending_update_count'), 'has_last_error': bool(webhook.get('last_error_message'))}
        if webhook.get('url'):
            async with httpx.AsyncClient(timeout=15, follow_redirects=False) as client:
                response = await client.post(webhook['url'], json={'update_id': 0})
                result['telegram']['public_gateway_unauthenticated_status'] = response.status_code
    except Exception as error:
        result['telegram_error_type'] = type(error).__name__
    if not args.skip_market:
        try:
            discovery = await search_market('Mouse Logitech M170')
            result['market'] = discovery.model_dump(mode='json')
            if discovery.products:
                product = discovery.products[0]
                reputation = await check_reputation(product.supplier_name, product)
                result['reputation'] = reputation.model_dump(mode='json')
        except Exception as error:
            result['market_error_type'] = type(error).__name__
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(result, indent=2, ensure_ascii=False))
    print('Sanitized integration evidence written to artifacts/final/external.json')

if __name__ == '__main__':
    asyncio.run(main())
