"""Inspect public HTTP refusals without cookies, authentication or challenge bypass."""
import asyncio
import json
import sys
from pathlib import Path
from urllib.parse import urlsplit

import requests
from bs4 import BeautifulSoup

root = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(root / 'backend'))
from app.tools import PinnedAdapter, RealMarketScraper
from app.scraper_tools import validate_public_url, timestamp, parse_product, parse_reputation, ProductOffer, ScrapingError


def inspect(url, address, supplier=None):
    parsed = urlsplit(url)
    with requests.Session() as session:
        session.trust_env = False
        session.mount(parsed.scheme + '://', PinnedAdapter(address, parsed.hostname))
        with session.get(url, headers={'Host': parsed.netloc, 'User-Agent': 'NexoProcurement/1.0', 'Accept-Language': 'pt-BR,pt;q=0.9'}, timeout=(5, 12), allow_redirects=False, stream=True) as response:
            data = bytearray()
            import time
            started = time.monotonic()
            for chunk in response.iter_content(65536):
                data.extend(chunk)
                if len(data) > 6000000 or time.monotonic() - started > 15:
                    break
            body = data.decode('utf-8', errors='replace')
            soup = BeautifulSoup(body, 'html.parser')
            result = {'status': response.status_code, 'headers': {k: v for k, v in response.headers.items() if k.lower() in {'server', 'content-type', 'retry-after', 'cf-mitigated', 'location'}}, 'title': soup.title.get_text() if soup.title else None, 'challenge_markers': [word for word in ['captcha', 'access denied', 'just a moment', 'enable javascript', 'cloudfront', 'request blocked'] if word in body.lower()]}
            if response.status_code == 200 and 'reclameaqui' not in url:
                try:
                    result['product'] = parse_product(body, url, 'Mouse Logitech M170').model_dump(mode='json')
                except ScrapingError as error:
                    result['extraction_error'] = str(error)
                result['product_markers'] = {selector: [node.get_text(' ', strip=True)[:300] for node in soup.select(selector)[:2]] for selector in ['#productTitle', '#corePriceDisplay_desktop_feature_div .priceToPay', '#availability', '#merchantInfoFeature_feature_div']}
            if response.status_code == 200 and 'reclameaqui' in url and supplier:
                try:
                    result['reputation'] = parse_reputation(body, url, ProductOffer.model_validate(supplier)).model_dump(mode='json')
                except ScrapingError as error:
                    result['extraction_error'] = str(error)
            return result


async def main():
    previous = json.loads((root / 'artifacts/final/external.json').read_text())
    candidates = previous['market']['candidates']
    hosts = ['kabum.com.br', 'amazon.com.br', 'pichau.com.br', 'magazineluiza.com.br']
    urls = [next((r['url'] for r in candidates if urlsplit(r['url']).hostname.removeprefix('www.') == host), None) for host in hosts]
    urls += [p['product_url'] for p in previous['market']['products'][:2]]
    urls += ['https://www.reclameaqui.com.br/empresa/logitech-store/']
    if '--only-reputation' in sys.argv: urls = urls[-1:]
    supplier = next(p for p in previous['market']['products'] if p['supplier_domain'] == 'logitechstore.com.br')
    result = {'checked_at': timestamp(), 'pages': []}
    async with RealMarketScraper() as scraper:
        for url in filter(None, urls):
            row = {'url': url}
            try:
                await scraper.policy.allow(url)
                row['robots'] = 'allowed'
                await scraper.policy.pace(url)
                row.update(await asyncio.to_thread(inspect, url, await validate_public_url(url), supplier))
            except Exception as error:
                row['error'] = str(error) if type(error).__name__ == 'ScrapingError' else type(error).__name__
            result['pages'].append(row)
            print(json.dumps(row, ensure_ascii=False), flush=True)
    (root / ('artifacts/reputation-diagnosis.json' if '--only-reputation' in sys.argv else 'artifacts/collection-diagnosis.json')).write_text(json.dumps(result, indent=2, ensure_ascii=False))


if __name__ == '__main__':
    asyncio.run(main())
