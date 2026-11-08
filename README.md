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

Com os builds de `api` e `frontend` atualizados, execute a stack atual pelo supervisor local:

```sh
backend/.venv/bin/python scripts/dev_nexo.py
```

Ele inicia Next.js, NestJS, agentes Python e gateway Telegram em loopback, com o Node 22 isolado e logs em `.local/logs/`. Ctrl+C encerra os quatro serviços. O túnel Telegram é iniciado separadamente. `scripts/dev.py` pertence à arquitetura antiga e não inicia a API NestJS.

Extração Tavily, correções de confiabilidade e evidências de validação: [revisão Tavily/Telegram](docs/revisao-tavily-telegram.md).


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

### Recomendação de compra com Jev

Configure `TYPESAFE_API_KEY` (ou o nome compatível `JEV_API_KEY`) somente no ambiente do serviço API. `TYPESAFE_MODEL` seleciona o modelo (padrão `jev-1.14.0`). `SUPPLIER_MAX_PREMIUM_PERCENT` define o prêmio máximo da cotação confirmada (padrão `5`). A API envia ao Jev os fatos de oferta necessários para julgamentos de equivalência do produto e suporte das evidências. Termos estruturados de uma cotação concluída permanecem como fatos confirmados, mesmo se Jev tiver baixa probabilidade; conversas privadas não são enviadas. O Jev não calcula valores: a API calcula todos os subtotais e TCO em centavos inteiros.

`POST /requests/:id/purchase-recommendation` recebe `{ "version": n }`. A resposta mantém visíveis todas as ofertas, incluindo a cotação do fornecedor confirmada e concluída, e mostra a melhor oferta de mercado, a fonte mais confiável e o comparador escolhido. Se faltarem frete ou taxas de qualquer lado, compara o mesmo subtotal de produto como referência provisória e lista as pendências; não estima custos desconhecidos. O prêmio configurado só se aplica à cotação do fornecedor completa e confirmada, quando os dois lados têm TCO e o prazo do fornecedor conhecido não é maior. Valores vencidos ou estoque conhecido insuficiente não são recomendados.

`POST /requests/:id/purchase-recommendation/approval` recebe `{ "review_id": "…", "version": n, "approved": true|false }`. A aprovação registra a oferta preferida na revisão persistida; ela não inicia uma compra simulada, não envia mensagem ao fornecedor e não cobra. O fluxo de simulação existente permanece separado. O `GET /requests/:id` inclui `latest_purchase_recommendation` para restaurar a revisão após recarregar a página; mudanças na solicitação tornam a revisão antiga obsoleta.

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

Os módulos históricos de voz em Python usam outro modelo de dados e não são montados pelo serviço `agents`. O NestJS agora recebe eventos de encerramento de voz e executa o fallback para WhatsApp; veja a configuração abaixo.

## Voz, WhatsApp e Telegram no Docker

O fluxo começa pelo convite de chamada WebRTC em `/call/[id]`. Sem atendimento em 120 segundos, solicita a cotação por texto no WhatsApp. Após mais 60 segundos sem resposta, aciona o Telegram. Uma resposta reconhecida fixa o canal antes da interpretação e cancela o fallback. Durante uma chamada ativa não há fallback; sua transcrição é enviada ao WhatsApp ao encerrar. A negociação por texto usa a mesma meta de 20% de desconto e até três contrapropostas. Uma aceitação inequívoca da contraproposta, como “Consigo sim”, conclui a cotação quando os demais termos estão confirmados e não mudaram; alterações exigem nova confirmação. O Kanban atualiza automaticamente a cada 2 segundos. A compra continua exigindo decisão humana.

Configure no `.env` `VAPI_PUBLIC_KEY` (chave pública), `VAPI_ASSISTANT_ID`, `INTERNAL_API_TOKEN` e as credenciais dos canais. A chave privada `VAPI_API_KEY` fica no servidor. Para uso no próprio computador:

```bash
docker compose up -d --build
```

Abra `http://localhost:3000`. Para parear, execute `docker compose --profile pairing up -d --build whatsapp-pairing` e abra `http://127.0.0.1:8766`. A Evolution precisa estar pareada com a conta do WhatsApp; os volumes preservam a sessão e as cotações. O webhook WhatsApp é configurado automaticamente para `http://api:4000/webhook/whatsapp`, autenticado com `WHATSAPP_WEBHOOK_SECRET`. Nenhum relay Python no host é necessário.

Para testar a chamada em outro aparelho, o navegador precisa de HTTPS e permissão de microfone. Use `PUBLIC_APP_URL=https://seu-dominio` apontando para o frontend ou inicie o túnel temporário opcional:

```bash
docker compose -f compose.yaml -f compose.public.yaml up -d --build
docker compose -f compose.yaml -f compose.public.yaml logs tunnel
```

O endereço HTTPS aparece nos logs do túnel. A API descobre esse endereço pela rede interna, usa-o nos próximos convites e registra o webhook Telegram. O túnel é independente dos outros serviços para preservar os links durante rebuilds da aplicação. O endereço temporário muda ao recriar o próprio túnel; use um domínio estável para manter links antigos válidos. O túnel publica a aplicação; habilite-o apenas durante a demonstração. Sem chave pública/assistente de voz, o fluxo informa a configuração ausente e começa no WhatsApp.

Validação sem envios reais: `npm run test:whatsapp` e `npm run test:voice` em `api/`. Os testes usam SQLite temporário e provedores HTTP simulados, incluindo reinícios, prazos persistidos, cancelamento por resposta, transcrição e confirmação final. Configuração da Evolution API v2 e pareamento: [docs/whatsapp.md](docs/whatsapp.md).

## Histórico operacional

A aba **Histórico** reúne solicitações, propostas, decisões e conversas persistidas. Acesse `/history` no frontend. Contratos, limitações das datas antigas e testes: [docs/historico.md](docs/historico.md).

Exclusão e repetição de compras: consulte [Ações de solicitações](docs/acoes-solicitacoes.md) para contratos, comportamento e testes.
