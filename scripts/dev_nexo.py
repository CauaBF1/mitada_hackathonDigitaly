#!/usr/bin/env python3
"""Run the current Next/Nest/agents stack locally with the project's Node runtime."""
import os
import signal
import subprocess
import sys
import time
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[1]
load_dotenv(ROOT / '.env', override=False)
NODE = ROOT / '.local/node-v22.23.4-linux-x64/bin/node'
PYTHON = ROOT / 'backend/.venv/bin/python'
if not NODE.is_file() or not PYTHON.is_file():
    sys.exit('Runtimes locais ausentes; consulte o README antes de iniciar.')
env = os.environ.copy()
env['PATH'] = str(NODE.parent) + os.pathsep + env.get('PATH', '')
env['PYTHONPATH'] = str(ROOT / 'backend')
env['DATABASE_PATH'] = str(ROOT / '.local/business.sqlite')
env.setdefault('AGENT_DATABASE_PATH', str(ROOT / '.local/agents.sqlite'))
env['AGENT_URL'] = 'http://127.0.0.1:8000'
env['NEST_API_URL'] = 'http://127.0.0.1:4000'
env['API_URL'] = 'http://127.0.0.1:4000'
env['HOST'] = '127.0.0.1'
commands = [
    ('agents', [str(PYTHON), '-m', 'uvicorn', 'app.agent_service:app', '--host', '127.0.0.1', '--port', '8000'], ROOT, {}),
    ('api', [str(NODE), 'dist/main.js'], ROOT / 'api', {'PORT': '4000'}),
    ('frontend', [str(NODE), 'node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1', '--port', '3000'], ROOT / 'frontend', {}),
    ('telegram-gateway', [str(PYTHON), 'scripts/telegram_webhook_gateway.py'], ROOT, {'GATEWAY_HOST': '127.0.0.1', 'GATEWAY_PORT': '8081'}),
]
if os.environ.get('WHATSAPP_GATEWAY_HOST'):
    commands.append(('whatsapp-gateway', [str(PYTHON), 'scripts/whatsapp_webhook_gateway.py'], ROOT, {
        'WHATSAPP_GATEWAY_HOST': os.environ['WHATSAPP_GATEWAY_HOST'],
        'WHATSAPP_GATEWAY_PORT': os.environ.get('WHATSAPP_GATEWAY_PORT', '8082'),
    }))
logs = ROOT / '.local/logs'
logs.mkdir(mode=0o700, parents=True, exist_ok=True)
processes = []
streams = []
stop_requested = False

def stop(*_):
    global stop_requested
    stop_requested = True

signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)
try:
    for name, command, cwd, overrides in commands:
        fd = os.open(logs / f'{name}.log', os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
        stream = os.fdopen(fd, 'a')
        streams.append(stream)
        process = subprocess.Popen(command, cwd=cwd, env={**env, **overrides}, stdout=stream, stderr=subprocess.STDOUT, start_new_session=True)
        processes.append(process)
        print(f'{name}: PID {process.pid}', flush=True)
    while not stop_requested and all(p.poll() is None for p in processes):
        time.sleep(0.5)
    if not stop_requested:
        print('Um serviço encerrou; consulte .local/logs/.', flush=True)
finally:
    for process in processes:
        if process.poll() is None:
            os.killpg(process.pid, signal.SIGTERM)
    for process in processes:
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait()
    for stream in streams:
        stream.close()
