import os
import signal
import subprocess
import sys
import time
from pathlib import Path


root = Path(__file__).resolve().parents[1]
python = root / "backend" / ".venv" / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
processes = []


def stop(signum=None, frame=None):
    for process in processes:
        if process.poll() is None:
            if os.name == "nt":
                process.terminate()
            else:
                os.killpg(process.pid, signal.SIGTERM)


if not python.exists():
    sys.exit("Execute make install antes de iniciar o projeto.")

signal.signal(signal.SIGINT, stop)
signal.signal(signal.SIGTERM, stop)
try:
    processes.append(subprocess.Popen(
        [str(python), "-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", "8000"],
        cwd=root / "backend", start_new_session=os.name != "nt",
    ))
    processes.append(subprocess.Popen(
        ["npm.cmd" if os.name == "nt" else "npm", "run", "dev", "--", "--port", "3000"],
        cwd=root / "frontend", start_new_session=os.name != "nt",
    ))
    while all(process.poll() is None for process in processes):
        time.sleep(0.5)
finally:
    stop()
    for process in processes:
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            if os.name == "nt":
                process.kill()
            else:
                os.killpg(process.pid, signal.SIGKILL)
            process.wait()
