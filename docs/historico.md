# Histórico operacional de compras

Acesse **Workspace → Histórico** ou `http://localhost:3000/history`. A aba usa o SQLite da API NestJS, incluindo solicitações antigas e decididas. Não altera o comportamento nem os prompts dos agentes.

A consulta oferece busca pelo nome do produto, estágio, período de criação, ordenação e páginas de 10, 20 ou 50 solicitações. Os filtros ficam na URL e podem ser recarregados ou compartilhados dentro do workspace. As datas do formulário correspondem ao horário local do navegador; a consulta envia limites ISO UTC, incluindo todo o último dia selecionado.

Cada linha representa uma solicitação, identificada pelo UUID, mesmo quando há várias pesquisas do mesmo produto. Ela mostra quantidade, destino, estágio, contagem de propostas aptas e com pendências, fornecedor escolhido e TCO em centavos. Propostas com frete, taxas, prazo, estoque ou confirmações pendentes continuam identificadas como parciais.

Ao selecionar um produto, os detalhes apresentam especificações, aviso atual, propostas completas, decisão, conversas e registros datados. As conversas são separadas por canal e contato; IDs de telefone/chat não são retornados pelo endpoint de histórico. O link **Abrir no Kanban** seleciona a mesma solicitação no painel existente.

## Limites dos registros existentes

O banco atual não persiste eventos de mudança de estágio nem a data da decisão. O histórico não inventa essas informações: mostra o estágio atual e mantém a data da decisão indisponível. A linha do tempo inclui somente criação da solicitação, criação das propostas e mensagens registradas. O último registro é a maior dessas datas; pode não corresponder à última alteração de estágio ou à decisão.

A identificação dos canais das propostas usa os prefixos já persistidos de WhatsApp, Telegram ou voz. Propostas sem essa informação continuam sem indicação de canal. Contatos de WhatsApp usam o nome cadastrado; contatos sem nome disponível recebem um rótulo genérico. As mensagens não são interpretadas novamente para construir o histórico.

Não há exclusão de registros antigos nem criação de dados de exemplo no banco da aplicação. A inicialização acrescenta apenas índices para as consultas. Este histórico é uma memória operacional para consulta humana; não implementa consulta automática dos agentes ao histórico.

## API

Os contratos de `/requests` e `/requests/:id/messages` permanecem iguais. Novas rotas somente de leitura:

- `GET /history`: lista paginada, com `items`, `total`, `filtered_total`, `page`, `page_size` e `pages`.
- `GET /history/:id`: detalhes, propostas, conversas agrupadas e linha do tempo factual.

Parâmetros opcionais da lista:

| Parâmetro | Valores |
| --- | --- |
| `q` | Nome do produto, até 200 caracteres; `%` e `_` são tratados como texto literal |
| `status` | `recebida`, `pesquisando`, `aguardando`, `comparação`, `decidida` |
| `created_from` | ISO UTC com milissegundos, limite inclusivo |
| `created_before` | ISO UTC com milissegundos, limite exclusivo |
| `sort` | `newest` (padrão) ou `oldest` |
| `page` | Inteiro positivo; páginas além do fim são ajustadas à última disponível |
| `page_size` | 1 a 100; padrão 20 |

```bash
curl -G http://localhost:4000/history \
  --data-urlencode 'q=SSD' \
  --data-urlencode 'status=comparação' \
  --data-urlencode 'page=1' \
  --data-urlencode 'page_size=20'

curl http://localhost:4000/history/UUID-DA-SOLICITACAO
```

A projeção da API de histórico não inclui análise interna do agente, payloads de tarefas, tokens, IDs externos de entrega ou números de chat. O proxy local do frontend encaminha somente as duas rotas de leitura.

## Validação

```bash
cd api
npm ci
npm run build
node scripts/history-smoke.mjs
node scripts/whatsapp-smoke.mjs
# Requer python3 para o gateway de teste:
node scripts/smoke.mjs

cd ../frontend
npm ci
npm run typecheck
npm run build
```

`history-smoke.mjs` usa SQLite temporário e fixtures exclusivas de teste. Verifica histórico vazio, busca literal, filtros combinados, limites de datas, ordenação, paginação, propostas parciais, decisão/TCO, separação de contatos, ausência de dados internos e persistência após reiniciar a API. As outras suítes verificam a regressão dos canais e dos contratos existentes, sem envio de mensagens reais.

A validação no navegador usa uma API e banco descartáveis, separadamente dos dados locais da aplicação, e cobre navegação, filtros, recarregamento, detalhes, conversas, acesso ao Kanban, responsividade, queda da API e recuperação.

## Arquivos desta alteração

- `api/src/history.ts`: consultas paginadas e projeção dos detalhes.
- `api/src/main.ts`: registro das novas rotas e do serviço de histórico.
- `frontend/app/history/page.tsx`: lista, filtros e paginação.
- `frontend/app/history/[id]/page.tsx` e `HistoryDetails.tsx`: detalhes e retorno à consulta.
- `frontend/app/history/contracts.ts` e `HistoryShell.tsx`: tipos, apresentação de valores e estrutura visual.
- `frontend/app/WorkspaceSidebar.tsx` e `frontend/app/page.tsx`: navegação compartilhada e acesso à solicitação no Kanban.
- `frontend/app/api/[...path]/route.ts`: encaminhamento das rotas de leitura, preservando a alteração local preexistente de hosts permitidos.
- `api/scripts/history-fixtures.mjs` e `api/scripts/history-smoke.mjs`: cenários e testes isolados.
- `README.md` e `docs/historico.md`: acesso, contratos, limites e instruções de validação.
