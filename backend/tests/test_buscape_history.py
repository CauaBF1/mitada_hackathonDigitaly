import asyncio
import json
from datetime import date
from decimal import Decimal
from pathlib import Path

import httpx
import pytest
from pydantic import ValidationError

from app.buscape_history import BuscapeHistoryProvider, ExternalHistory, parse_product, parse_search, product_url
from app import price_timing_agent as timing

FIXTURES = Path(__file__).parent / 'fixtures'
URL = 'https://www.buscape.com.br/mouse/mouse-gamer-optico-sem-fio-pro-x-superlight-logitech'
TODAY = date(2026, 11, 8)


def test_search_retains_variants_as_explicit_choices():
    choices = parse_search((FIXTURES / 'buscape-search.html').read_text())
    assert len(choices) == 3
    assert 'Superlight 2' in choices[0].title
    assert choices[1].url == URL
    assert 'Superlight -' in choices[1].title


def test_extracts_first_party_dated_prices_and_provenance():
    result = parse_product((FIXTURES / 'buscape-product.html').read_text(), URL)
    assert len(result.history) == 40
    assert result.source.url == URL
    assert result.source.available_start == date(2026, 9, 30)
    assert result.source.available_end == TODAY
    assert result.history[0]['price'] == Decimal('599.00')
    assert min(p['price'] for p in result.history) == Decimal('459.90')
    assert result.history[-1]['supplier'] == 'Buscapé · loja 1582'


@pytest.mark.parametrize('url', ['http://www.buscape.com.br/a/b','https://www.buscape.com.br.evil.test/a/b','https://www.buscape.com.br@127.0.0.1/a/b','https://www.buscape.com.br:443/a/b','https://www.buscape.com.br/a/b?x=1','https://www.buscape.com.br/a/b#x','https://www.buscape.com.br/a/../private'])
def test_source_url_cannot_target_another_host_or_resource(url):
    with pytest.raises(ValueError):
        product_url(url)
    with pytest.raises(ValidationError):
        timing.PriceTimingInput(item_name='Mouse',price_source='reference',source_url=url)


def test_parser_does_not_use_other_product_prices_or_invent_missing_days():
    data=json.loads((FIXTURES/'buscape-product.html').read_text().split('>',1)[1].split('</script>')[0])
    records=data['props']['initialReduxState']['priceHistory']['priceHistory']['7515098']['days']
    records[:]=[dict(prodId=999,date='2026-11-01',price=1),dict(prodId=7515098,date='2026-11-02',price=0),dict(prodId=7515098,date='2026-11-03',price='NaN'),dict(prodId=7515098,date='2026-11-04',price='99.999'),dict(prodId=7515098,date='2026-11-08',price='90.50')]
    result=parse_product('<script id="__NEXT_DATA__">'+json.dumps(data)+'</script>',URL)
    assert len(result.history)==1
    assert result.history[0]['price']==Decimal('90.50')
    assert result.history[0]['date']==TODAY
    assert 'não identificada' in result.history[0]['supplier']
    with pytest.raises(ValueError):
        parse_product((FIXTURES/'buscape-product.html').read_text(),URL+'-2')


@pytest.mark.parametrize('mode',['search','product','blocked','redirect','schema'])
def test_provider_reads_public_site_and_fails_closed(mode):
    calls=[]
    def handler(request):
        calls.append(str(request.url))
        if mode=='blocked':return httpx.Response(403,text='Access denied')
        if mode=='redirect':return httpx.Response(302,headers={'location':'http://127.0.0.1/private'})
        if mode=='schema':return httpx.Response(200,text='<html>No history</html>')
        return httpx.Response(200,text=(FIXTURES/('buscape-product.html' if mode=='product' else 'buscape-search.html')).read_text())
    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            return await BuscapeHistoryProvider(client).fetch('mouse superlight',URL if mode=='product' else None)
    result=asyncio.run(run())
    assert len(calls)==1
    if mode=='search':
        assert result.candidates and result.history==[] and result.source is None
        assert '/busca/mouse+superlight' in calls[0]
    elif mode=='product':assert len(result.history)==40
    else:assert result.error=='external_unavailable' and result.history==[]


@pytest.mark.parametrize('days,count',[(30,30),(60,40),(90,40)])
def test_analysis_uses_external_points_only_and_never_pads_coverage(monkeypatch,days,count):
    async def fetch(*args):return parse_product((FIXTURES/'buscape-product.html').read_text(),URL)
    async def unavailable(*args):raise RuntimeError('LLM disabled in test')
    monkeypatch.setattr(BuscapeHistoryProvider,'fetch',fetch)
    monkeypatch.setattr(timing.PriceTimingAgent,'_invoke',unavailable)
    result=asyncio.run(timing.PriceTimingAgent().analyze(timing.PriceTimingInput(item_name='Mouse',selected_price='900',price_source='selected',external_history=True,source_url=URL,days=days,history=[dict(date='2026-11-08',price='1',supplier='Local must not contaminate series')]),TODAY))
    assert len(result.history)==count
    assert result.data_source=='external' and result.history_basis=='daily_minimum'
    assert result.source.url==URL
    assert min(p.price for p in result.history)>1
    assert result.analysis.lowest_historical_price==min(p.price for p in result.history)


def test_no_external_history_does_not_fallback_to_local_quotes(monkeypatch):
    async def fetch(*args):return ExternalHistory(message='Site indisponível',error='external_unavailable')
    monkeypatch.setattr(BuscapeHistoryProvider,'fetch',fetch)
    p=timing.PriceTimingInput(item_name='Mouse',selected_price='900',price_source='selected',external_history=True,history=[dict(date='2026-11-08',price='1',supplier='Local')])
    result=asyncio.run(timing.PriceTimingAgent().analyze(p,TODAY))
    assert result.history==[] and result.analysis is None and result.external_error=='external_unavailable'
