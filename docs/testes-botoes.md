# Resultado dos testes: excluir e refazer compra

Validação executada em 07/11/2026, usando as imagens locais de API e frontend da implementação. Frontend isolado em `http://127.0.0.1:3102`, SQLite temporário `/tmp/buttons.sqlite` dentro do container de teste e serviço de agentes simulado. Nenhuma mensagem foi enviada a fornecedores reais.

## Cliques na interface

| Local da ação | Refazer compra | Cancelar exclusão | Confirmar exclusão |
| --- | --- | --- | --- |
| Card do Kanban, solicitação decidida | Passou: novo ID e gaveta aberta | Passou: original preservado | Passou: card removido |
| Gaveta, solicitação sem propostas | Passou: novo ID selecionado | Passou: original preservado | Passou: solicitação removida e gaveta fechada |
| Linha do Histórico, solicitação decidida | Passou: navegação ao novo ciclo no Kanban | Passou: original preservado | Passou: linha removida |
| Detalhes do Histórico, proposta parcial | Passou: navegação ao novo ciclo no Kanban | Passou: original preservado | Passou: redirecionamento ao Histórico |

As quatro confirmações de exclusão foram feitas somente sobre os registros artificiais autorizados pelo usuário: “Teste botões — Card”, “Teste botões — Gaveta”, “Teste botões — Histórico” e “Teste botões — Detalhes”.

## Conferência direta no banco e no serviço simulado

- Após as repetições: 8 solicitações, sendo 4 originais intactas e 4 novos ciclos.
- Cada novo ciclo preservou produto, especificações, quantidade e destino, com ID e tarefa próprios. Os quatro despachos foram recebidos pelo agente simulado.
- Os novos ciclos não herdaram propostas, decisões, análise nem conversas. Ficaram em `pesquisando`, com uma tarefa `accepted` cada.
- Após excluir os quatro originais pela interface: 4 solicitações restantes, correspondentes aos novos ciclos; zero registros vinculados aos IDs excluídos em todas as tabelas com `request_id`.
- Os quatro IDs excluídos retornaram 404 nas consultas pelo proxy de solicitações e pelo Histórico.
- `PRAGMA integrity_check`: `ok`. `PRAGMA foreign_key_check`: sem violações. Zero registros órfãos nas tabelas vinculadas.
- Recarregar o site preservou os novos ciclos e não trouxe de volta os registros excluídos.
- Nenhum erro de JavaScript foi capturado no navegador durante os testes.

## Testes automáticos executados novamente

- `api/scripts/request-actions-smoke.mjs`: passou. Inclui sobrescritas e validação, criação de tarefas independentes, rollback da criação e exclusão, limpeza das tabelas dependentes, isolamento entre solicitações, resultados atrasados de envios/interpretações, callbacks antigos e persistência após reiniciar.
- `api/scripts/history-smoke.mjs`: passou.
- `api/scripts/whatsapp-smoke.mjs`: passou.

Esses testes também usam SQLite temporário e provedores simulados. Instruções de execução e exemplos HTTP estão em [acoes-solicitacoes.md](acoes-solicitacoes.md).

## Dados reais

O ambiente principal em `3000` permaneceu com 2 solicitações, 6 propostas e 10 mensagens. Nenhum dos registros reais foi excluído ou repetido por estes testes. Os containers e a rede temporários foram removidos após a validação.

A exclusão é permanente no banco de negócio ativo; não há lixeira no produto. Backups preexistentes, mensagens já entregues nos aplicativos dos fornecedores e checkpoints do serviço Python separado não são apagados por esse endpoint.
