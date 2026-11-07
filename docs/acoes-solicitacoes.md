# Excluir solicitação e refazer compra

As ações estão nos cards do Kanban, na gaveta, nas linhas do Histórico e nos detalhes do Histórico. Nos cards e linhas, “Refazer compra” aparece para solicitações decididas; nos detalhes/gaveta, pode ser usada em qualquer estágio. Excluir exige confirmação e remove permanentemente a solicitação com seus registros vinculados. Excluir pelos detalhes do Histórico retorna a `/history`.

“Refazer compra” abre automaticamente a nova solicitação no Kanban e inicia o fluxo existente de pesquisa. Copia apenas produto, especificações, quantidade e destino. Propostas, decisões, contatos e conversas não são herdados. Se Telegram estiver configurado, o novo fluxo pode registrar uma nova notificação própria. Não há mudança no agente Python ou em seus prompts.

## Contratos

- `DELETE /requests/:id`: HTTP 200 `{ "ok": true, "id": "..." }`; inexistente: 404. A transação remove propostas, tarefas, mensagens, entregas/mapeamentos Telegram, idempotência de contato, contatos/entregas/inbox/estado de proposta/chamadas WhatsApp e updates Telegram vinculados pelas mensagens. Solicitações de outros ciclos permanecem intactas.
- `POST /requests/:id/repeat`: HTTP 201, no mesmo formato de `POST /requests`. Body opcional `{ "qty": 3, "destination": "15000-000" }`. Somente esses dois campos podem ser sobrescritos; valores inválidos: 400; original inexistente: 404. A criação de solicitação e tarefa é atômica. O registro nasce `recebida` e passa a `pesquisando` durante o despacho normal.
- Proxy: `DELETE /api/request/:id` e `/api/requests/:id`; `POST /api/request/:id/repeat` e `/api/requests/:id/repeat`. Repetição retorna o contrato de frontend (`item`, `stage`, `sources`, etc.). Mantém a validação de origem existente.

Resultados de interpretações/envios em andamento não recriam registros após a exclusão. Callbacks de tarefas removidas retornam 404. Respostas explícitas a uma mensagem cujo vínculo foi excluído são ignoradas em ambos os canais, sem serem atribuídas a outra solicitação. Uma mensagem já enviada ao fornecedor não pode ser recolhida por esta exclusão; trabalhos já aceitos pelo serviço Python podem terminar, mas não repovoam o SQLite da solicitação excluída.

## Testes automáticos

Na pasta `api`, com dependências instaladas:

```bash
npm run build
node scripts/request-actions-smoke.mjs
node scripts/history-smoke.mjs
node scripts/whatsapp-smoke.mjs
node scripts/smoke.mjs
```

O último teste usa Python 3 para o gateway Telegram. Os testes usam bancos SQLite temporários e servidores locais simulados, sem mensagens a fornecedores reais. O teste de ações cobre cópia e sobrescritas, validação, nova tarefa, preservação do original, rollback forçado, limpeza de todas as tabelas vinculadas, isolamento entre ciclos, callbacks antigos, exclusão durante envio/interpretação e persistência após reiniciar.

Se Node estiver disponível somente no container, execute o teste de ações assim, a partir da raiz:

```bash
podman compose build api frontend
podman run --rm --entrypoint sh \
  -v "$PWD/api/scripts:/checks:ro" \
  localhost/mitada_hackathondigitaly_api:latest \
  -c 'cp -R /checks /app/scripts && cd /app && node scripts/request-actions-smoke.mjs'
```

## Verificação manual

Use uma instalação de teste; a criação/repetição aciona os agentes e canais configurados. Em `http://127.0.0.1:3000`, teste:

1. Abrir uma solicitação sem propostas ou com proposta parcial pela gaveta e clicar em “Refazer compra”. A nova solicitação deve abrir com outro ID e sem propostas anteriores.
2. Repetir uma decidida pelo card e pela linha no Histórico; a decisão original deve permanecer.
3. Abrir “Excluir solicitação” pelo card, gaveta, linha e detalhes; cancelar deve manter os dados. Confirmar deve remover o item e, nos detalhes do Histórico, retornar à listagem.
4. Recarregar o site e conferir que a nova solicitação persiste e a excluída não reaparece. Testar excluir o último item de uma página com filtros ativos.
5. Com a API de teste indisponível, conferir a mensagem de erro e a liberação dos botões para nova tentativa.

Exemplo via proxy, usando somente uma solicitação descartável criada para este teste:

```bash
NEXO_BASE=http://127.0.0.1:3000/api
NEXO_ORIGINAL_ID=$(curl -fsS "$NEXO_BASE/request" \
  -H 'Content-Type: application/json' \
  -d '{"item":"Produto descartável de teste","qty":2,"delivery_location":"01001-000"}' \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')

NEXO_REPEAT_ID=$(curl -fsS -X POST "$NEXO_BASE/request/$NEXO_ORIGINAL_ID/repeat" \
  -H 'Content-Type: application/json' -d '{"qty":3,"destination":"15000-000"}' \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')

curl -fsS "$NEXO_BASE/request/$NEXO_REPEAT_ID"
curl -fsS -X DELETE "$NEXO_BASE/requests/$NEXO_REPEAT_ID"
curl -i "$NEXO_BASE/request/$NEXO_REPEAT_ID"  # 404
curl -fsS -X DELETE "$NEXO_BASE/request/$NEXO_ORIGINAL_ID"
```
