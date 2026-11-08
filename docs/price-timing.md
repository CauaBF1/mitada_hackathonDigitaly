# Histórico de preços e timing de compra

A seção está em `/dashboard/analise-economica`, junto dos indicadores econômicos existentes. O seletor temporal também aceita solicitações ainda sem decisão final.

## Contrato e origem dos dados

`GET /api/procurement/{request_id}/price-history?days=60` aceita períodos de 30, 60 ou 90 dias. O proxy Next encaminha para a rota Nest de mesmo caminho sem `/api`; a API Nest consulta seu SQLite e envia somente os dados necessários para `POST /price-timing/analyze`, autenticado com `INTERNAL_API_TOKEN` no serviço de agentes.

A consulta combina cotações persistidas do mesmo nome de produto, JSON de especificações e quantidade. Não há scraping de históricos de Zoom, Buscapé ou Keepa. Os valores são **unitários em BRL**, sem frete ou taxas. A referência obedece à prioridade: preferência de mercado, decisão, cotação concluída e, por último, cotação mais recente. Esse último caso é identificado como referência, não como escolha final.

A resposta contém `history`, `analysis`, `observed_history`, `historical_average`, `selected_price`, `selected_date`, `price_source`, `data_source`, `analysis_source`, `days`, `real_observation_count` e `message`. Datas usam UTC; valores monetários e percentuais decimais são strings. Sem preço disponível, `analysis` e `selected_price` são nulos e nenhuma referência é inventada.

## Cálculos e dados insuficientes

Uma série real exige ao menos sete datas distintas distribuídas por pelo menos sete dias dentro do período. A média diária equilibra fornecedores e evita que repetidas capturas do mesmo fornecedor tenham peso extra. Média histórica e percentil usam essas médias diárias; a mínima e a máxima são observações individuais. Empates usam o ponto médio do percentil: uma série plana com preço atual igual à média resulta em percentil 50. A tendência compara a média do primeiro terço com a do último, com faixa estável de ±3%.

Quando há menos de sete datas em um intervalo de pelo menos sete dias, a API retorna apenas as observações reais disponíveis, com `analysis` e `historical_average` nulos e `analysis_source="insufficient_data"`. A interface pode desenhar essas observações, mas não mostra uma média, tendência, percentil ou recomendação. Nenhum preço atual é projetado para datas passadas, e não se interpola histórico ausente.

## Agente e indisponibilidade

`PriceTimingAgent` é isolado dos agentes existentes. Com histórico suficiente, usa `ChatGoogleGenerativeAI(model="gemini-2.5-flash")` ou `ChatGroq`, conforme o provedor configurado, com saída estruturada `PriceTimingReport` e campos extras proibidos. Se o Google responder que o modelo 2.5 não existe mais, tenta o `GEMINI_MODEL` já configurado no projeto; falhas de autenticação ou cota não acionam essa troca. As métricas são calculadas com `Decimal` e não podem ser substituídas pelo modelo; a confiança tem limite conforme a quantidade de datas observadas. A justificativa é interpretativa, sem promessas de preços futuros.

Falhas de credencial, provedor, validação ou timeout usam uma leitura estatística explicitamente identificada por `analysis_source="statistical_fallback"`. A indisponibilidade do serviço de agentes retorna 503, com botão para tentar novamente na interface. Consultar ou atualizar esta seção não cria tarefas de negociação, chamadas ou mensagens a fornecedores.

## Verificação

- Backend: `python -m pytest tests/test_price_timing_agent.py -q` dentro de `backend`.
- API: `npm run test:price-history` dentro de `api` (SQLite temporário e agente stub, sem contatos reais).
- Frontend: `npm run typecheck` e `npm run build` dentro de `frontend`.
