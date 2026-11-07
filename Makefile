.PHONY: install dev test build e2e e2e-controlled coverage

install:
	python3 -m venv backend/.venv
	backend/.venv/bin/python -m pip install -r backend/requirements.lock
	backend/.venv/bin/python -m pip install --no-deps -e backend
	cd frontend && npm ci

dev:
	python3 scripts/dev.py

test:
	cd backend && .venv/bin/python -m pytest
	cd frontend && npm run typecheck

build:
	cd frontend && npm run build

e2e: build
	cd frontend && npm run test:e2e

e2e-controlled: build
	cd frontend && npm run test:e2e:controlled

coverage:
	cd backend && .venv/bin/python -m pytest --cov=app --cov-branch --cov-report=term-missing --cov-report=json:../artifacts/final/coverage.json --junitxml=../artifacts/final/pytest.xml
