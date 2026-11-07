import json
import os
import socket
import sqlite3
import subprocess
import sys
import time
from contextlib import closing
from pathlib import Path

import httpx
import pytest

ROOT = Path(__file__).resolve().parents[2]


def wait_for(client, predicate, timeout=20):
    deadline = time.monotonic() + timeout
    last = None
    while time.monotonic() < deadline:
        try:
            last = client.get('/godmode/dashboard').json()
            if predicate(last):
                return last
        except (httpx.HTTPError, ValueError):
            pass
        time.sleep(0.1)
    raise AssertionError(f'Workflow did not reach expected state: {last}')


@pytest.mark.parametrize('mode', ['live', 'sandbox'])
def test_gate_a_b_c_d_restart_negotiation_and_memory(tmp_path, mode):
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]
    output = open(tmp_path / 'server.log', 'w')
    process = None
    def start():
        return subprocess.Popen([sys.executable, str(Path(__file__).parent / 'support/scenario_server.py'), '--data-dir', str(tmp_path), '--port', str(port)], cwd=ROOT / 'backend', stdout=output, stderr=subprocess.STDOUT)
    def latest_message(request_id):
        with closing(sqlite3.connect(tmp_path / 'scenario.db')) as db:
                return db.execute("select telegram_message_id from telegram_chat_messages where request_id=? and supplier_domain='example.com' and sender_type='AI' and telegram_message_id is not null order by id desc limit 1", (request_id,)).fetchone()[0]
    def reply(client, request_id, identity, text):
        return client.post('/webhook/telegram', headers={'X-Telegram-Bot-Api-Secret-Token': 'controlled-webhook-secret'}, json={'update_id': identity, 'message': {'message_id': identity + 10000, 'chat': {'id': 555123, 'type': 'private'}, 'reply_to_message': {'message_id': latest_message(request_id)}, 'text': text}})
    try:
        process = start()
        with httpx.Client(base_url=f'http://127.0.0.1:{port}', timeout=5) as client:
            wait_for(client, lambda data: data['runs'] == [])
            created = client.post('/request', json={'item': 'Capacete industrial certificado', 'qty': 100, 'delivery_location': 'CEP 01001-000, SP', 'mode': mode}, headers={'Idempotency-Key': 'restart-gate'})
            assert created.status_code == 201, created.text
            identity = created.json()['id']
            wait_for(client, lambda data: data['runs'][0]['status'] == 'NEGOTIATING')
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline:
                traces = client.get(f'/request/{identity}/trace').json()
                if any(t['status'] == 'paused' for t in traces):
                    break
                time.sleep(0.1)
            assert any(t['status'] == 'paused' for t in traces)
            with closing(sqlite3.connect(tmp_path / 'checkpoints.sqlite')) as db:
                assert db.execute('select count(*) from checkpoints').fetchone()[0] > 0
            first = client.get(f'/chat/{identity}').json()
            process.kill()
            process.wait(timeout=10)
            process = start()
            wait_for(client, lambda data: data['runs'][0]['id'] == identity)
            assert client.get(f'/chat/{identity}').json() == first
            initial = 'R$ 110 cada, 100 unidades, frete R$ 200, Seguro R$ 20, 5 dias úteis, Pix, CEP 01001-000'
            assert reply(client, identity, 501, initial).status_code == 200
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline and latest_message(identity) == 101:
                time.sleep(0.1)
            assert reply(client, identity, 501, initial).json()['duplicate']
            final = 'Confirmo R$ 80 cada, 100 unidades, frete R$ 40, Seguro R$ 10, 5 dias úteis, Pix, CEP 01001-000'
            assert reply(client, identity, 502, final).status_code == 200
            data = wait_for(client, lambda data: data['runs'][0]['status'] == 'DONE')
            row = data['runs'][0]
            assert row['quote']['initial_price'] == '110'
            assert DecimalString(row['quote']['initial_tco']) == '11220.00'
            assert DecimalString(row['quote']['final_tco']) == '8050.00'
            assert row['hard_savings'] == '3000.00'
            assert row['cost_avoidance'] == ('2000.00' if mode == 'sandbox' else '2500.00')
            assert row['audit']['tco_savings'] == '3170.00'
            assert row['audit']['source_type'] == ('sandbox_supplier' if mode == 'sandbox' else 'supplier_telegram')
            assert data['metrics']['hard_savings'] == ('0.00' if mode == 'sandbox' else '3000.00')
            assert data['metrics']['final_spend'] == ('0.00' if mode == 'sandbox' else '8050.00')
            assert reply(client, identity, 503, final).json()['ignored']
            with closing(sqlite3.connect(tmp_path / 'scenario.db')) as db:
                assert db.execute('pragma foreign_key_check').fetchall() == []
                assert db.execute('pragma integrity_check').fetchone()[0] == 'ok'
                assert db.execute('select count(*) from telegram_supplier_outcomes').fetchone()[0] == 1
                assert db.execute("select count(*) from telegram_chat_messages where sender_type='SUPPLIER'").fetchone()[0] == 2
            second = client.post('/request', json={'item': 'Capacete industrial certificado', 'qty': 100, 'delivery_location': '01001-000', 'mode': mode}).json()['id']
            second_row = wait_for(client, lambda data: data['runs'][0]['status'] == 'NEGOTIATING')['runs'][0]
            profile = second_row['supplier_profiles']['example.com']
            assert profile['has_previous_history'] is True
            assert profile['historical_discount_avg_pct'] == '27.27'
            reply(client, second, 504, initial)
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline:
                chat = client.get(f'/chat/{second}').json()
                if any('Pelo histórico' in message['text'] for message in chat):
                    break
                time.sleep(0.1)
            assert any('Pelo histórico' in message['text'] for message in chat)
            traces = client.get(f'/request/{identity}/trace').json()
            assert {t['node'] for t in traces} == {'discovery_node', 'memory_profiler_node', 'tactical_negotiator_node', 'compliance_auditor_node'}
            artifacts = ROOT / 'artifacts/final'
            artifacts.mkdir(parents=True, exist_ok=True)
            (artifacts / f'gate-{mode}.json').write_text(json.dumps({'mode': mode, 'external_dependencies': 'CONTROLLED TEST RESPONSES; NOT LIVE SUPPLIERS', 'backend_process_restart': True, 'metrics': data['metrics'], 'quote': row['quote'], 'audit': row['audit'], 'trace': traces, 'memory_reused': profile}, indent=2))
    finally:
        if process and process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=10)
        output.close()


def DecimalString(value):
    from decimal import Decimal
    return f'{Decimal(value):.2f}'
