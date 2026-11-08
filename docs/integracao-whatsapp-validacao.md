# Integração WhatsApp e conferência econômica

## Canais no workspace

O dashboard identifica solicitações com retornos pendentes do WhatsApp. O drawer mostra termos por `supplier_id`, calcula o total somente quando unitário, frete e taxas estão disponíveis em centavos, e mantém campos ausentes como não informados. A análise econômica repete esses dados em um bloco separado, sem incorporá-los às economias ou ao gasto final antes de confirmação. O chat identifica cada mensagem por canal e contato. O histórico detalhado já separa conversas por canal e contato. Uma cotação WhatsApp não vira fonte de pesquisa de mercado só por ter mensagem ou preço.

O backend atual não tem uma conclusão de cotação WhatsApp confirmada. Portanto, os retornos permanecem pendentes e não alimentam indicadores de compra concluída. O fluxo de chamada por link continua fora deste escopo.

## Verificação de preços via Tavily

Consulta real executada em **08/11/2026 às 14:25:01 UTC** (horário em que a evidência foi registrada): `Mouse Logitech M170 preço Brasil produto novo com valor em reais`. Uma extração retornou o anúncio Amazon abaixo; a extração da página de busca Magazine Luiza falhou. O preço é evidência pontual do anúncio, não uma medição de todo o mercado.

- [Amazon Brasil — Logitech M170 preto, modelo 910-004940](https://www.amazon.com.br/Mouse-Nanoreceptor-Inclusa-Logitech-Mouses/dp/B074L9L5KZ): novo por **R$ 55,90**; o anúncio também listava usado por R$ 46,42, excluído da comparação. O trecho extraído condicionava frete grátis a primeiro pedido, com entrega indicada para 10/11. Quantidade disponível, elegibilidade do comprador, CEP e custo final de entrega não foram confirmados.
- [Magazine Luiza — resultados para M170 preto](https://www.magazineluiza.com.br/busca/mouse+logitech+m170+sem+fio+preto): o resultado de busca mostrava ofertas a partir de R$ 74,82 e R$ 80,91, mas a extração falhou. Esses valores ficam como indícios de busca, sem uso nos cálculos.
- [Ibyte — M170 azul-claro](https://www.ibyte.com.br/mouse-sem-fio-logitech-m170-azul-claro-design-ambidestro-compacto-conexao-usb-e-pilha-inclusa/p): a busca mostrava R$ 66,40 no Pix, mas a cor SKU/variante é azul-claro; excluída da comparação do M170 preto.

O único preço extraído corresponde ao SKU preto 910-004940, mas é uma oferta unitária observada sem validação de estoque para duas unidades nem frete para um destino específico. Para duas unidades, o subtotal publicado seria **R$ 111,80** (5.590 centavos × 2); o TCO permanece desconhecido até validar entrega e elegibilidade do frete grátis.

## Conferência da aritmética econômica

Os valores a seguir vêm do caso de teste local de quantidade/TCO para o M170, e não de uma compra ou negociação real. Para duas unidades, a cotação inicial de R$ 110,00 por unidade + R$ 20,00 de frete soma **R$ 240,00**. A cotação final de R$ 80,00 por unidade + R$ 5,00 de frete soma **R$ 165,00**. O fornecedor declarou ausência de taxas adicionais nesse fixture.

- Hard Savings: (11.000 − 8.000 centavos) × 2 = **6.000 centavos / R$ 60,00**.
- Economia no frete: 2.000 − 500 = **1.500 centavos / R$ 15,00**.
- Redução de TCO: 24.000 − 16.500 = **7.500 centavos / R$ 75,00**.
- Cost Avoidance do fixture usa média de mercado de R$ 100,00 por unidade e frete publicado zero: (10.000 − 8.000) × 2 = **4.000 centavos / R$ 40,00**. Essa referência de fixture não é o preço real encontrado na Tavily.

Se alguma base, frete ou taxa estiver ausente, o total correspondente permanece indisponível. Uma proposta acima da referência é acréscimo, não economia. Produtos de cor/SKU diferente, ofertas usadas e contatos WhatsApp não são misturados ao baseline de mercado.

## Reclame Aqui e validação final — 08/11/2026

A consulta real da Cobasi Loja Online confirmou nota **8,3/10**, selo RA1000 e período 01/05/2026–31/10/2026 na página oficial https://www.reclameaqui.com.br/empresa/cobasi-loja-online/, via Tavily Extract. A consulta Samsung encontrou uma assistência técnica sem vínculo comprovado com samsung.com.br e acesso bloqueado; a nota permanece desconhecida. Bloqueios de origem e quota real não são tratados como reputação verificada.

Validação integrada: **345 testes Python**, **2 testes do gateway WhatsApp**, **10 scripts de integração da API** e **2 testes Playwright focados no dashboard e histórico insuficiente** passaram. Builds de produção da API e frontend passaram com Node 22; `docker compose config --quiet` passou. A suíte Playwright completa legada não foi executada nesta validação.

A Evolution local foi pareada pelo usuário e confirmou estado `open`. Os cinco serviços foram reiniciados após backup SQLite: dashboard, API e agentes retornaram HTTP 200; o relay rejeitou acesso sem segredo e encaminhou evento próprio de verificação, ignorado pela API. O webhook Evolution aponta para o relay em docker0. Não houve envio de mensagens de teste a fornecedores reais.

WhatsApp é o primeiro canal configurado; sem resposta por **30 segundos**, o fluxo recorre ao Telegram. Resposta, cancelamento e exclusão interrompem o fallback, inclusive durante confirmação atrasada de envio. O prazo e o estado persistem para recuperação após reinício. O link de ligação futuro não foi implementado neste merge.
