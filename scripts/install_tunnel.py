import hashlib
import json
import os
import platform
import urllib.request
from pathlib import Path


root = Path(__file__).resolve().parents[1]
architecture = {'x86_64': 'amd64', 'aarch64': 'arm64'}.get(platform.machine())
if not architecture or platform.system() != 'Linux':
    raise SystemExit('Instalador disponível para Linux amd64/arm64.')
request = urllib.request.Request('https://api.github.com/repos/cloudflare/cloudflared/releases/latest', headers={'Accept': 'application/vnd.github+json', 'User-Agent': 'Nexo-Local-Webhook'})
with urllib.request.urlopen(request, timeout=30) as response:
    release = json.load(response)
asset = next(a for a in release['assets'] if a['name'] == f'cloudflared-linux-{architecture}')
digest = asset.get('digest', '')
if not digest.startswith('sha256:'):
    raise SystemExit('A distribuição não publicou o SHA-256 esperado; instalação interrompida.')
url = asset['browser_download_url']
if not url.startswith('https://github.com/cloudflare/cloudflared/releases/download/'):
    raise SystemExit('Origem inesperada do binário.')
bin_dir = root / '.local' / 'bin'
bin_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
temporary = bin_dir / 'cloudflared.download'
try:
    sha = hashlib.sha256()
    size = 0
    with urllib.request.urlopen(url, timeout=60) as response, temporary.open('wb') as file:
        while chunk := response.read(1024 * 1024):
            size += len(chunk)
            if size > 150_000_000:
                raise RuntimeError('Distribuição excedeu o tamanho esperado.')
            sha.update(chunk)
            file.write(chunk)
    if sha.hexdigest() != digest.removeprefix('sha256:'):
        raise RuntimeError('Verificação de integridade falhou.')
    os.chmod(temporary, 0o700)
    temporary.replace(bin_dir / 'cloudflared')
    print(f"cloudflared {release['tag_name']} instalado com SHA-256 verificado.")
finally:
    temporary.unlink(missing_ok=True)
