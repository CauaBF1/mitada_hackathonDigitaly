# Revisão e conclusão — Tavily e Telegram

Validação em 08/11/2026. Alterações do Argon preservadas e complementadas por revisão. Sem commit ou push.

## Resultado e limites

A integração usa REST no Python (`/search` e `/extract`), com a credencial existente. O produto não depende da CLI Tavily. O setup oficial consultado foi https://tavily.com/agent-setup/SKILL.md; as orientações de aplicação e extração foram conferidas na skill `tavily-best-practices` instalada.

A conta foi verificada como Researcher, com 870 créditos restantes no início da validação. Esse número é um retrato, não saldo garantido. Pay-as-you-go não foi habilitado. Bloqueios continuam possíveis: o sistema tenta extração alternativa e mantém os dados desconhecidos quando não consegue validar.

## Complementos à implementação do Argon

- Corrigido o bloqueio de conversa: um timeout externo à Promise liberava a fila sem cancelar a operação anterior. Agora o bloqueio dura até o trabalho terminar; as chamadas de rede mantêm seus próprios prazos de cancelamento.
- Removido traceback sem sanitização e ampliada a sanitização de diagnósticos.
- Corrigida a identidade de vendedor: “Mega Eletrônicos e entregue por Magalu” e nomes apenas contendo a marca não são considerados venda direta da loja.
- Estoque e taxas ausentes na extração textual continuam desconhecidos. A presença de preço não confirma disponibilidade.
- Aplicados os filtros de domínio também na pesquisa complementar.
- Reservado orçamento antes de chamadas concorrentes, incluindo extrações que falham. No máximo cinco chamadas de extração e quatro créditos estimados por instância do scraper, por padrão. Basic reserva um crédito; advanced, dois. A reserva é conservadora, inclusive quando a API informa cobrança zero.
- Não há repetição automática de extração após timeout ou HTTP 5xx, pois a requisição pode ter consumido créditos. Retentativas são limitadas a falhas de conexão.
- Conteúdo retornado para outra URL não é atribuído à URL solicitada.
- Perfil explicitamente identificado como loja física não fornece reputação para a oferta online.
- Updates antigos sem vínculo persistido, ou com mensagens posteriores já processadas na mesma conversa, exigem revisão em vez de reaplicar termos antigos.
- Telegram HTTP 5xx ou resposta sem identificador válido fica como entrega incerta, sem reenvio automático.
- Adicionado `scripts/dev_nexo.py` para iniciar a arquitetura atual. `scripts/dev.py` continua sendo legado.

As demais mudanças do Argon incluem recuperação da inbox após reinício, limites de interpretação, tratamento de `terms: null` do modelo, separação de falhas de extração e cache curto para determinadas falhas transitórias de reputação.

## Evidências reais

1. Tavily Search respondeu pela integração Python existente.
2. Tavily Extract leu a página do Reclame Aqui que a leitura direta anteriormente não alcançava.
3. O fluxo `POST /reputation-refresh` do serviço Python em execução retornou o perfil **Cobasi — Loja Online**, URL `https://www.reclameaqui.com.br/empresa/cobasi-loja-online/`, nota **8,3/10**, classificação **RA1000**, período **01/05/2026 a 31/10/2026**, método `tavily_extract/basic` e cinco indícios separados. Hash da evidência: `3fbde05fc9b1c4486484d02a257920c43df6efaa82cd132a7955602179ad5527`.
4. Uma chamada real ao endpoint interno `/conversation-turn`, com contexto de teste sobre Hisense, retornou HTTP 200 e uma resposta natural do Gemini. Essa chamada não enviou Telegram e não comprova compatibilidade técnica do modelo citado.
5. Os serviços em 3000, 4000 e 8000 responderam HTTP 200. GET no caminho público do gateway retornou 404, como esperado; o webhook aceita POST autenticado.
6. O webhook antigo registrava erro 530 e duas atualizações pendentes. Um novo túnel foi criado somente para o gateway em 8081, o webhook foi registrado com segredo e sem descartar pendências, e `TELEGRAM_WEBHOOK_URL` foi atualizado no `.env` ignorado pelo Git. Após a recuperação: zero updates externos pendentes e nenhum erro atual no `getWebhookInfo`.
7. A inbox local ficou com 40 updates processados e um antigo preservado para revisão. O SQLite retornou `integrity_check = ok`.

Não foi validada uma nova oferta comercial Hisense em loja real nesta revisão. Os testes de extração de produto e de preço usam fixtures; não constituem proposta de fornecedor. A extração real de reputação é uma evidência separada.

## Caso Hisense

No banco local `.local/business.sqlite`, a solicitação `d829773f-5a83-427e-85f1-06ac73f74b53` já estava `decidida`, com `quote_completion_state=concluida` e mensagem final registrada como enviada. O histórico mostrou entregas incertas por `ETIMEDOUT` e um placeholder de processamento pendente que foi enviado como resposta.

Isso confirma falhas históricas de entrega e o placeholder; não prova uma única causa para todo silêncio relatado. Nenhuma mensagem incerta da Hisense foi reenviada nem sua cotação foi reprocessada nesta revisão. O Telegram confirma aceitação de envio, não leitura pelo usuário.

O update antigo `960771442` estava `processing`, sem mensagem persistida nem resposta vinculada a uma solicitação. Após a recuperação ficou `exhausted`, com motivo explícito de revisão manual. Não foi associado à solicitação mais recente nem apagado.

## Testes

Com Node 22 isolado do projeto:

- `npm run build` em `api`: passou.
- `npm run typecheck` e `npm run build` em `frontend`: passaram.
- 107 testes Python focados em search provider, product parsers, collection resilience, agent service, agent intelligence e webhook gateway: passaram. Avisos de depreciação de dependência LangSmith/Python 3.14 permanecem.
- `api/scripts/telegram-recovery.mjs`: passa por processamento pendente, reinício real da API, resposta final única, duplicatas, turnos lentos serializados, histórico sem vínculo e entregas incertas.
- Smokes de Telegram, conclusão de cotação, simulação de compra, WhatsApp, ações de solicitações e histórico: passaram usando mocks locais e SQLite descartável.
- `docker compose config --quiet` e `git diff --check`: passaram. Containers não foram iniciados; o usuário local não possui acesso ao socket Docker.

O teste de recuperação pode ser executado com `cd api && node scripts/telegram-recovery.mjs` após o build. Não usa credenciais reais nem envia mensagens a fornecedores.

## Correção da pesquisa após relato de falha — 08/11/2026

Esta atualização substitui a ressalva anterior de que uma nova oferta comercial não havia sido validada. Uma consulta real isolada de `Samsung Galaxy S25 Ultra` levou 20,17 s e retornou 28 candidatos e três ofertas com preço extraído. Não foi criada solicitação de negócio e nenhum Telegram foi enviado.

| Página retornada | Nome/variante visível | Preço extraído |
| --- | --- | ---: |
| [Magazine Você](https://www.magazinevoce.com.br//magazineeconommizze/smartphone-samsung-galaxy-s25-ultra-256gb-5g-titanio-cinza-com-caneta-s-pen-galaxy-ai-camera-quadrupla-200mp-selfie-12mp-ram-12gb-tela-6-9/p/cfgdg4hf72/te/g25u/) | Samsung Galaxy S25 Ultra 256 GB, 5G, titânio cinza, 12 GB RAM | R$ 5.165,10 |
| [Amazon Brasil](https://www.amazon.com.br/Celular-Samsung-Galaxy-Qu%C3%A1drupla-Tit%C3%A2nio/dp/B0DSYJCY45/) | Título retornado menciona Samsung Galaxy, câmera quádrupla e titânio; capacidade e correspondência exata ao modelo não foram confirmadas | R$ 5.199,00 |
| [Samsung Brasil](https://shop.samsung.com/br/galaxy-s25-ultra/p?skuId=8443) | Página Galaxy S25 Ultra; a variante associada ao SKU não foi confirmada nesta coleta | R$ 5.776,67 |

Os preços são valores capturados nas páginas, não cotações fechadas. Frete, estoque e equivalência da variante não foram confirmados. Os erros de coleta visíveis incluíram páginas sem preço inequívoco em Mercado Livre e Americanas, além de HTTP 403 em Magalu.

O diagnóstico separou dois comportamentos: o endpoint `/usage` respondeu HTTP 429 com `Retry-After: 60`, enquanto `/search` respondeu HTTP 200 com cinco resultados. A busca estava sendo interrompida pelo diagnóstico de saldo, antes da consulta `/search`; o fluxo de pesquisa e extração agora respeita cache e cooldown de saldo sem condicionar a busca à consulta de `/usage`. Os limites de busca, reserva de créditos, orçamento de extração e restrição ao plano gratuito continuam em vigor. Pay-as-you-go não foi ativado. A tela de configurações está conectada ao caminho Next → NestJS → Python para consultar estado e cadastrar a credencial; os testes exercitam autenticação, origem, resposta sem credencial e integração simulada por `MockTransport`.

Os três testes dos wrappers internos passaram. Na validação consolidada do projeto, passaram 106 testes Python focados em 9,69 s e a integração de busca da API (Node 22) e build do frontend. Permaneceram 13 avisos de depreciação do LangSmith/Python 3.14.

Não houve nova consulta a `/usage` durante a coleta real isolada. O resultado demonstra pesquisa e extração em páginas acessíveis, mas bloqueios e páginas sem preço verificável continuam possíveis; as três ofertas ainda precisam de confirmação comercial humana.

## Operação e recuperação

Para iniciar, com builds atualizados e sem outra instância ocupando as portas:

```sh
backend/.venv/bin/python scripts/dev_nexo.py
```

Logs locais: `.local/logs/`. Ctrl+C encerra os quatro serviços filhos. O túnel é um processo separado e temporário; se reiniciado, sua URL precisa ser atualizada no webhook e no `.env`. Não exponha diretamente NestJS ou Python.

As opções `LLM_TIMEOUT_SECONDS`, `TAVILY_EXTRACT_*` e `GATEWAY_TIMEOUT_SECONDS` estão descritas por seus defaults no `.env.example`. As opções dos agentes também são encaminhadas pelo Compose. O limite do scraper não é um limite global mensal de todas as solicitações; a conta é consultada antes das chamadas.

Antes de iniciar a stack foram criados backups consistentes via SQLite Backup API em `.local/backups/before-final-review-20261108T134416Z/`, para `business.sqlite` e `agents.sqlite`. Eles são anteriores à recuperação das duas mensagens pendentes.

Para reverter código, preserve o diff completo antes de restaurar apenas os trechos desejados; não faça reset geral sobre o trabalho do Argon. Pare os serviços antes de qualquer restauração de banco. Restaurar o backup perde os registros posteriores e não recolhe mensagens já enviadas; não é uma ação automática de rollback. O webhook deve apontar ao gateway que permanecer ativo.
