# Nexo · Inteligência de compras

Aplicação para registrar solicitações, pesquisar referências públicas, comparar propostas e apoiar uma decisão humana.

- **API NestJS** (`api/`): REST, SQLite de negócio, propostas, decisão humana e webhook Telegram.
- **Agentes Python** (`backend/app/agent_service.py`): LangGraph, pesquisa/parsing reaproveitados e checkpoints SQLite isolados. Não escreve no banco de negócio; devolve resultados por callback à API Nest.
- **Next.js** (`frontend/`): formulário, Kanban e comparação. O proxy `/api/*` usa `API_URL` no servidor Next.

## Executar

Com Docker Compose:

```sh
cp .env.example .env
docker compose up --build
```

Adicione `TAVILY_API_KEY` ao `.env` da raiz para habilitar a busca Tavily usada na pesquisa de produtos e reputação. O `.env.example` contém apenas um placeholder; obtenha a chave no painel Tavily. A integração respeita o plano gratuito e pausa buscas quando não há créditos gratuitos disponíveis.

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

### Conversa e reputação internas

O serviço Python autentica essas rotas com `Authorization: Bearer $INTERNAL_API_TOKEN`:

- `POST /conversation-turn`: recebe `product`, `qty`, `destination`, `message`, `history` (`sender_type`/`content`), `phase` (`opening`, `quotation`, `quote_confirmation`, `quote_completed` ou `purchase`), `terms` e `missing_fields`. Retorna `intent`, `reply`, `terms`, `explicit_confirmation`, `terms_changed` e `purchase_acceptance`. Valores monetários em `terms` usam centavos inteiros (`*_cents`); pendências continuam nulas. Na conversa o agente representa o comprador falando com o fornecedor. Perguntas sobre requisitos ainda não fornecidos são encaminhadas ao solicitante, pedindo ao fornecedor suas opções.
- `POST /reputation-refresh`: recebe `offers` com `source_url` e `supplier`; retorna `reputations` verificadas pelo parser oficial estrito, `reputation_indications` de busca com trecho, URL e timestamp, e `checked_at`. Indicações de busca nunca são reputação verificada. Cache por domínio: 24 horas; domínio ausente ou inválido resulta em reputação desconhecida.

Na simulação de compra, a cotação só avança após confirmação humana; o Telegram pode registrar/aceitar essa confirmação no fluxo. Isso não executa pagamento nem afirma que houve compra concluída.

Depois que a API confirmar o encaminhamento dos contratos, com o serviço Python em `http://127.0.0.1:8000`, faça os smokes autenticados abaixo. Eles usam o token já exportado no ambiente e não o imprimem:

```sh
curl -sS http://127.0.0.1:8000/conversation-turn \
  -H "Authorization: Bearer $INTERNAL_API_TOKEN" -H 'Content-Type: application/json' \
  -d '{"product":"RAM DDR4 3200","qty":7,"destination":"01001-000","message":"Você precisa de quantos GB em cada pente?","history":[],"phase":"quotation","terms":null,"missing_fields":["capacidade"]}'

curl -sS http://127.0.0.1:8000/reputation-refresh \
  -H "Authorization: Bearer $INTERNAL_API_TOKEN" -H 'Content-Type: application/json' \
  -d '{"offers":[{"source_url":"https://loja.example/produto","supplier":"Loja"}]}'
```

Esses comandos são instruções de smoke, não evidência de execução live. Resultados de Gemini/Tavily só serão considerados validados após rodar e inspecionar as respostas no ambiente integrado.

## Validação

Os testes herdados em `backend/tests` incluem contratos do desenho FastAPI anterior e não validam automaticamente a arquitetura Nest atual. Use `npm run build` em `api/`, `npm run typecheck`/`npm run build` em `frontend/`, os testes Python aplicáveis e `docker compose config` conforme dependências disponíveis. Não há fixtures de propostas inventadas no dashboard.

Voz e WhatsApp estão fora do fluxo ativo. Módulos históricos foram mantidos da base incorporada, mas não são montados pelos serviços descritos acima.
