"""Disposable test backend with explicitly controlled external integrations."""
import subprocess
import sys
from pathlib import Path
from tempfile import TemporaryDirectory

root = Path(__file__).resolve().parents[1]
with TemporaryDirectory(prefix='nexo-controlled-e2e-') as directory:
    raise SystemExit(subprocess.call([sys.executable, str(root / 'backend/tests/support/scenario_server.py'), '--data-dir', directory, '--port', '8001']))
