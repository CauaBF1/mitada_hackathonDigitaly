# Dashboard: custos e histórico externo

A seção fica em `/dashboard/analise-economica`.

## Cards de custo

- **Custo do fornecedor**: preço unitário informado pelo fornecedor direto (WhatsApp ou Telegram), preservado mesmo quando a opção escolhida é uma oferta da internet. Usa a cotação concluída quando identificada, ou a proposta direta mais recente com preço.
- **Menor custo**: menor preço unitário entre esse fornecedor e as ofertas de mercado levantadas na solicitação. Não é um valor de economia. A disponibilidade e os termos das ofertas continuam sujeitos à confirmação.
- **Custo total final**: mantém o total auditado, incluindo quantidade, frete e taxas.

Os dois primeiros cards excluem frete e taxas para comparar a mesma base. Valores ausentes aparecem como indisponíveis; não se assume custo zero. A seleção do mínimo usa centavos inteiros (`BigInt`).

## Busca direta no Buscapé

`GET /api/procurement/{request_id}/price-history?days=60` busca o nome do item na página pública `https://www.buscape.com.br/busca/{item}`. Retorna `source_candidates` para o comprador confirmar o modelo/geração correto, evitando usar por engano o histórico de uma variante parecida.

Depois da seleção, a mesma rota recebe `source_url=https://www.buscape.com.br/categoria/produto`. A API Nest envia o preço atual e o nome do item ao agente interno; apenas a consulta pública do item ou o endereço do produto é enviado ao Buscapé. Dados de contatos, endereço de entrega e mensagens não fazem parte da consulta ao site.

O módulo `backend/app/buscape_history.py` lê a série publicada em `__NEXT_DATA__.props.initialReduxState.priceHistory.priceHistory[product_id].days`. Confere o ID do produto, sua página canônica, data, valor positivo finito e precisão de centavos. Os pontos representam o **menor preço diário publicado pelo comparador**, sem frete e taxas. Quando o nome da loja não consta do registro, mostra o identificador original, sem inventar um nome.

A resposta inclui `source` (nome do site, URL, produto, data da consulta e intervalo disponível), `source_candidates`, `history_basis="daily_minimum"` e `data_source="external"` quando houver série. A interface permite conferir o gráfico original e escolher outro produto.

## Cobertura e indisponibilidade

Os períodos de 30/60/90 dias filtram somente datas existentes na fonte. A página pode disponibilizar, por exemplo, 40 dias; selecionar 90 dias **não cria os 50 dias restantes**. O intervalo disponibilizado pelo site e a quantidade de datas na janela aparecem na tela. Não há simulação, interpolação de datas ou mistura silenciosa com cotações do SQLite.

A série real exige pelo menos sete datas distribuídas por sete dias para calcular tendência, percentil e recomendação. Sem preço atual, é possível consultar o histórico, mas a comparação de timing fica indisponível. A análise usa médias dos menores preços diários, com cálculos `Decimal`; a mínima e a máxima são observações da fonte. Empates usam o ponto médio do percentil.

Páginas sem histórico, mudanças de formato, HTTP 403/429 e timeouts geram um estado de indisponibilidade, sem números artificiais. Não se tenta contornar bloqueios ou desafios. Somente URLs HTTPS de produtos em `www.buscape.com.br` são aceitas; redirecionamentos são validados e a leitura tem limites de tempo e tamanho. A integração depende do formato público do site, não de uma API oficial contratada.

## Agente

`PriceTimingAgent` permanece isolado dos agentes de pesquisa e negociação. Usa saída estruturada `PriceTimingReport`, campos extras proibidos e métricas calculadas sem permitir que o modelo substitua os números. Quando Gemini 2.5 retorna modelo inexistente, tenta `GEMINI_MODEL`; erros de autenticação ou cota não acionam essa troca. Falhas da IA usam uma leitura estatística identificada, baseada na mesma série real. Consultar o gráfico não cria negociações, chamadas ou mensagens.

## Testes

- Backend: `python -m pytest tests/test_price_timing_agent.py tests/test_buscape_history.py -q` em `backend`.
- API: `npm run test:price-history` em `api` (SQLite temporário e agente stub).
- Cards: `node --experimental-strip-types scripts/economic-costs-test.mjs` em `frontend` com Node 22.
- Frontend: `npm run typecheck` e `npm run build`.

Os arquivos em `backend/tests/fixtures/buscape-*.html` são recortes dos dados públicos capturados em 08/11/2026, usados somente nos testes de regressão do parser. A aplicação em execução consulta o site; não utiliza essas fixtures.
