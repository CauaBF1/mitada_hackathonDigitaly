# Correção de respostas por canal — 08/11/2026

## Diagnóstico

A Evolution registrou uma resposta privada 17 segundos após o envio WhatsApp. O contato correspondia a duas solicitações locais; a busca de mensagens sem resposta citada incluía solicitações já concluídas e devolvia ambiguidade. Não havia mensagem de fornecedor registrada no canal WhatsApp. A configuração local também estava em 30 segundos; as entregas históricas de fallback ocorreram após aproximadamente 31 segundos. A configuração local foi corrigida para 60 segundos.

O botão Jev existia no drawer do produto concluído, mas ficava abaixo do painel de custos, fora da área inicialmente visível. A reprodução por clique no cartão do Kanban mediu o botão abaixo de uma janela de 700px. O painel foi movido para o topo do drawer.

## Comportamento corrigido

- Mensagens WhatsApp sem citação procuram a solicitação ativa, sem contar solicitações concluídas como abertas. Ambiguidade entre solicitações realmente ativas continua exigindo correlação explícita.
- Durante os primeiros 60 segundos, a resposta WhatsApp interrompe o fallback antes da interpretação pelo agente.
- Sem resposta, o Telegram é acionado após o prazo persistido. O envio não decide o vencedor: a primeira resposta aceita entre WhatsApp e Telegram registra o canal da conversa.
- As próximas mensagens do canal vencedor continuam aceitas. O outro canal não altera os termos da mesma solicitação.
- O vencedor persiste no SQLite e é removido com a solicitação. O gateway registra motivos de eventos ignorados sem registrar conteúdo, números ou segredos.

## Validação

Testes isolados de WhatsApp cobrem prazo persistido, cancelamento durante envio, correlação, retorno após fallback e disputa entre canais. Regressões de recuperação Telegram, conclusão de cotação, ações da solicitação e compra simulada passaram. Dois testes do relay passaram. O teste Playwright abre o cartão concluído pelo Kanban e verifica o botão Jev na primeira área visível antes de exercitar recomendação e aprovação com mocks. Build de produção do frontend passou.

Não foram enviadas mensagens reais a fornecedores nem feitas novas chamadas ao Jev durante essa correção.
