# Recomendação de compra com Jev — validação

Em 08/11/2026, a skill TypeSafe foi instalada com `npx skills add typesafe-ai/skills --skill typesafe-ai --agent codex --yes`. A integração usa a chave do servidor `TYPESAFE_API_KEY`, com compatibilidade com `JEV_API_KEY`, e o modelo `jev-1.14.0`. A política atual usa `SUPPLIER_MAX_PREMIUM_PERCENT=5`, substituindo o fator inicial 0,8.

O Jev avalia equivalência do produto e suporte das evidências. O código calcula `preço unitário × quantidade + frete + taxas` em centavos. Uma cotação canônica concluída e confirmada pelo fornecedor mantém seus fatos estruturados, independentemente de Jev atribuir probabilidade baixa; a conversa privada não é enviada ao Jev. Sem custos completos dos dois lados, compara os subtotais como referência provisória e mantém frete e taxas desconhecidos como nulos. `SUPPLIER_MAX_PREMIUM_PERCENT` define o prêmio máximo (padrão 5%). Ele só se aplica à cotação confirmada completa quando os dois lados têm TCO completo e prazo conhecido do fornecedor não é maior que o prazo de mercado.

A tela mostra todas as ofertas, incluindo a cotação confirmada do fornecedor mesmo quando Jev tem baixa confiança, a fonte mais confiável e o comparador escolhido. Sim/Não registra a preferência na revisão persistida. A aprovação não inicia pedido, cobrança ou mensagem. O fluxo existente de compra simulada permanece separado. Versão, conteúdo das ofertas, política e validade são conferidos antes da aprovação; revisão substituída ou baseada na política antiga é rejeitada.

## Provas

- Dez chamadas reais ao TypeSafe, todas HTTP 200, dentro do limite explicitamente autorizado. Foram usados apenas dados fictícios. Payloads e respostas estão em `artifacts/final/jev-live-validation.json`; nenhuma chave está nesse arquivo.
- Os primeiros casos mostraram que somente domínio e valores eram evidência insuficiente. A versão final envia trecho capturado da oferta com contatos removidos, sem reduzir o limiar de probabilidade de 0,7.
- Fornecedor confirmado R$ 105,00 vs site R$ 100,00 → dentro do prêmio máximo de 5%.
- Fornecedor confirmado R$ 107,00 vs site R$ 100,00 → site recomendado.
- Custos ausentes → base comum de subtotal, sem inventar TCO.
- Evidência fraca → revisão necessária, sem escolha automática.
- Testes locais de regras e contrato HTTP passaram, incluindo centavos, limiar, custos desconhecidos, vencimento, persistência, aprovação/recusa, idempotência, revisão obsoleta, erro do provedor e ausência de efeitos de compra.
- Dois testes Playwright focados passaram: solicitação explícita, resumo/cálculo, aprovação persistida após reload, pendências e erro do Jev.
- Builds de produção da API e frontend passaram. Regressões de conclusão de cotação e compra simulada passaram.

Não foi feita compra real nem envio de mensagens a fornecedores durante esses testes. A qualidade da recomendação depende das evidências disponíveis; ofertas sem suporte suficiente continuam exigindo revisão.


## Correção da proposta do fornecedor e simplificação do painel

A proposta negociada já existia no banco, mas era descartada na seleção ao receber baixa probabilidade do modelo, sobretudo quando não havia texto livre em condições. Agora a cotação concluída é verificada pelo identificador e pelo snapshot exato dos termos confirmados. Preço, frete, taxas, prazo e estoque são apresentados como fatos registrados; a avaliação do Jev fica separada desses fatos.

Foram executadas seis novas chamadas reais com dados fictícios, dentro de autorização específica de seis requisições, todas HTTP 200. Os payloads e respostas estão em `artifacts/final/jev-supplier-validation.json`. Os seis resultados corresponderam aos casos esperados: margem de 5%, custo acima da margem, única cotação confirmada, fornecedor mais lento, custos desconhecidos e anúncio de outra marca. Uma reexecução local de revisão real, usando respostas já salvas do Jev e sem chamada externa, confirmou que a proposta antes omitida passa a permanecer na recomendação.

O painel principal apresenta opção proposta, valores do fornecedor e do site, motivo objetivo e botões de aceitar/recusar. Cálculo, evidências e probabilidades ficam em detalhes expansíveis. Revisões da política antiga ficam obsoletas e precisam ser recalculadas.
