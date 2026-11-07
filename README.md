# Nexo · Inteligência de compras

Aplicação para registrar solicitações, pesquisar referências públicas, comparar propostas e apoiar uma decisão humana. A base funcional elegível de `hackathon_digitally_priv` foi incorporada; seu original permanece intocado. A arquitetura ativa separa negócio, agentes e interface em três serviços:

- **API NestJS** (`api/`): REST, SQLite de negócio, propostas, decisão humana e webhook Telegram.
- **Agentes Python** (`backend/app/agent_service.py`): LangGraph, pesquisa/parsing reaproveitados e checkpoints SQLite isolados. Não escreve no banco de negócio; devolve resultados por callback à API Nest.
- **Next.js** (`frontend/`): formulário, Kanban e comparação. O proxy `/api/*` usa `API_URL` no servidor Next.

## Executar

Com Docker Compose:

```sh
cp .env.example .env
docker compose up --build
```

Abra http://localhost:3000. A API Nest fica em http://localhost:4000 e os agentes só são expostos na rede interna Compose. Os dados de negócio e os checkpoints usam volumes distintos.

### Desenvolvimento local e integrações

O `.env` da raiz contém as credenciais locais. Para o Python carregá-lo antes da configuração, inicie os agentes a partir da raiz:

```sh
PYTHONPATH=backend backend/.venv/bin/python -c 'from dotenv import load_dotenv; load_dotenv(".env"); import os, uvicorn; os.environ.setdefault("NEST_API_URL", "http://127.0.0.1:4000"); os.environ.setdefault("AGENT_DATABASE_PATH", ".local/agents.sqlite"); uvicorn.run("app.agent_service:app", host="127.0.0.1", port=8000)'
```

O provider automático usa Gemini quando `GEMINI_API_KEY` existe; o modelo padrão em `GEMINI_MODEL` é `gemini-3.8-flash`. `LLM_PROVIDER=groq` fixa o provider Groq opcional. Não copie credenciais para comandos ou logs.

Para iniciar a API Nest local, use o Node isolado do projeto: `.local/node-v22.23.4-linux-x64` (Node 22.23.4). O addon SQLite `better-sqlite3` não é compatível com o runtime Node 26 instalado no sistema. Em outro terminal, na raiz:

```sh
export PATH="$PWD/.local/node-v22.23.4-linux-x64/bin:$PATH"
set -a; . ./.env; set +a
cd api && AGENT_URL=http://127.0.0.1:8000 npm run dev
```

Inicie o frontend em outro terminal com o mesmo Node isolado: `export PATH="$PWD/.local/node-v22.23.4-linux-x64/bin:$PATH"; cd frontend && API_URL=http://127.0.0.1:4000 npm run dev`.

Para Telegram, execute `backend/.venv/bin/python scripts/telegram_webhook_gateway.py` a partir da raiz. O gateway carrega o `.env` raiz e aceita/encaminha somente `POST /webhook/telegram` para a API local. Exponha somente esse gateway com `.local/bin/cloudflared tunnel --url http://127.0.0.1:8081` e configure no Telegram a URL HTTPS resultante terminada em `/webhook/telegram`, com o secret token já definido no `.env`. Não exponha diretamente a API Nest nem o serviço Python pelo túnel.

Defina `API_URL=http://localhost:4000` para o servidor Next local. A demo end-to-end ainda **não está marcada como totalmente validada**.

## Fluxo e contratos

1. Crie a solicitação com `product`, `specs`, `qty` e `destination`.
2. Nest persiste o registro e submete tarefa interna ao agente Python.
3. O agente pesquisa e extrai produtos com fontes e evidências; envia propostas encontradas de volta à API. Frete, taxas e prazo não confirmados ficam `null`.
4. A comparação calcula `qty × unit_price + shipping + fees` somente quando frete e taxas estão confirmados. Ordena TCO crescente e, em empate, prazo crescente. Valores desconhecidos permanecem no fim.
5. Uma pessoa escolhe a proposta; não há aprovação ou compra automática. Não há requisito mínimo de três fornecedores, nota de reputação ou desconto alvo.

Rotas principais:

- `GET/POST /requests` e `GET /requests/:id`
- `POST /requests/:id/quotes` e `POST /requests/:id/decision`
- `POST /tasks/:id/result` (callback interno do agente)
- `POST /webhook/telegram` (atualizações do bot; proposta direta no formato `/quote ID fornecedor|preço unitário|frete|taxas|prazo em dias|condições`, campos não confirmados vazios)
- Serviço Python interno: `POST /tasks`, `GET /health`

`TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET` e `GEMINI_API_KEY` existem somente no ambiente dos serviços. Configure um webhook HTTPS com o segredo correspondente no Telegram. A integração processa comandos de proposta recebidos; o bot não inicia conversas com fornecedores nem presume autorização para contatá-los.

## Validação

Os testes herdados em `backend/tests` incluem contratos do desenho FastAPI anterior e não validam automaticamente a arquitetura Nest atual. Use `npm run build` em `api/`, `npm run typecheck`/`npm run build` em `frontend/`, os testes Python aplicáveis e `docker compose config` conforme dependências disponíveis. Não há fixtures de propostas inventadas no dashboard.

Os módulos históricos de voz em Python usam outro modelo de dados e não são montados pelo serviço `agents`. O NestJS agora recebe eventos de encerramento de voz e executa o fallback para WhatsApp; veja a configuração abaixo.

## WhatsApp e fallback de voz

Configuração da Evolution API v2, QR Code, webhooks e exemplos de teste com `curl`: [docs/whatsapp.md](docs/whatsapp.md).
