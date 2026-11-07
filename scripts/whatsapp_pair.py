#!/usr/bin/env python3
"""Local QR viewer: keeps Evolution credentials server-side and refreshes QR changes."""
import argparse
import json
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HTML = '''<!doctype html><html lang="pt-BR"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Parear WhatsApp — Nexo</title>
<style>body{font:18px system-ui;margin:40px auto;max-width:620px;padding:0 20px;color:#18322b;background:#f3f7f5}main{background:white;padding:28px;border-radius:20px}h1{font-size:28px}img{display:block;width:348px;max-width:100%;margin:24px auto}#state{font-weight:650}small{color:#50645e}</style>
<main><h1>Conectar WhatsApp da Nexo</h1><p>No celular: <b>Aparelhos conectados → Conectar aparelho</b>.</p><p>Escaneie o QR abaixo. Ele é atualizado automaticamente. Se o código mudar durante a leitura, escaneie a nova imagem.</p><img id="qr" alt="Aguardando QR Code"><p id="state">Consultando Evolution…</p><small>Use o número da Nexo. O destinatário do teste deve ser outro número. As chaves da API permanecem no servidor local.</small></main>
<script>
const qr=document.getElementById('qr'), state=document.getElementById('state');
async function refresh(){let connected=false;try{const r=await fetch('/status',{cache:'no-store'});const d=await r.json();if(!r.ok)throw new Error(d.error||'Falha ao consultar Evolution');connected=d.state==='open';state.textContent=connected?'WhatsApp conectado! Pode voltar ao chat.':'Aguardando leitura e confirmação no celular…';if(connected){qr.hidden=true;}else if(d.qr){if(qr.getAttribute('src')!==d.qr)qr.src=d.qr;qr.hidden=false;}}catch(e){state.textContent=e.message;}if(!connected)setTimeout(refresh,2000);}refresh();
</script></html>'''


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--env-file', type=Path, default=Path(__file__).resolve().parent.parent / '.env')
    parser.add_argument('--port', type=int, default=8766)
    parser.add_argument('--url', default='http://127.0.0.1:8080')
    args = parser.parse_args()
    config = {}
    for line in args.env_file.read_text().splitlines():
        if '=' in line and not line.lstrip().startswith('#'):
            key, value = line.split('=', 1)
            config[key.strip()] = value.strip().strip('\"\'')
    key = config.get('WHATSAPP_API_KEY', '')
    if not key:
        parser.error('WHATSAPP_API_KEY ausente no arquivo de configuração')
    instance = urllib.parse.quote(config.get('WHATSAPP_INSTANCE_NAME', 'nexo'), safe='')

    def evolution(path):
        request = urllib.request.Request(args.url.rstrip('/') + path, headers={'apikey': key})
        with urllib.request.urlopen(request, timeout=10) as response:
            return json.load(response)

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_GET(self):
            # The browser never receives API keys or arbitrary upstream responses.
            if self.path == '/':
                self.respond(200, HTML.encode(), 'text/html; charset=utf-8')
            elif self.path == '/status':
                try:
                    status = evolution('/instance/connectionState/' + instance).get('instance', {}).get('state', 'close')
                    qr = None
                    if status != 'open':
                        data = evolution('/instance/connect/' + instance)
                        qr = data.get('base64') or data.get('qrcode', {}).get('base64')
                        if not isinstance(qr, str) or not qr.startswith('data:image/png;base64,'):
                            qr = None
                    self.respond(200, json.dumps({'state': status, 'qr': qr}).encode(), 'application/json')
                except urllib.error.HTTPError as error:
                    self.respond(502, json.dumps({'error': f'Evolution HTTP {error.code}'}).encode(), 'application/json')
                except (OSError, ValueError):
                    self.respond(502, b'{"error":"Evolution indisponivel; aguarde e tente novamente."}', 'application/json')
            else:
                self.respond(404, b'Not found', 'text/plain')

        def respond(self, status, body, content_type):
            self.send_response(status)
            self.send_header('Content-Type', content_type)
            self.send_header('Cache-Control', 'no-store')
            self.send_header('X-Content-Type-Options', 'nosniff')
            self.send_header('Referrer-Policy', 'no-referrer')
            self.end_headers()
            self.wfile.write(body)

    server = ThreadingHTTPServer(('127.0.0.1', args.port), Handler)
    print(f'Pareamento local: http://127.0.0.1:{args.port}', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == '__main__':
    main()
