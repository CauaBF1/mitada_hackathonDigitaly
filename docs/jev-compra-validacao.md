# Recomendação de compra com Jev — validação

Em 08/11/2026, a skill TypeSafe foi instalada com `npx skills add typesafe-ai/skills --skill typesafe-ai --agent codex --yes`. A integração usa a chave do servidor `TYPESAFE_API_KEY`, com compatibilidade com `JEV_API_KEY`, e o modelo `jev-1.14.0`. O fator configurável `SUPPLIER_PREFERENCE_FACTOR` tem padrão `0.8`.

O Jev avalia equivalência do produto e suporte das evidências. O código calcula `preço unitário × quantidade + frete + taxas` em centavos. Sem custos completos, compara o subtotal dos produtos dos dois lados, preservando custos desconhecidos como nulos e mostrando pendências. O custo de comparação do fornecedor recebe fator 0,8; o preço real não muda. Esse fator permite um prêmio de até 25% em relação ao comparador confiável, respeitado o arredondamento monetário.

A tela mostra a menor oferta, a fonte mais confiável, o comparador confiável escolhido, a cotação do fornecedor e a conta. Sim/Não registra a preferência na revisão persistida. A aprovação não inicia pedido, cobrança ou mensagem. O fluxo existente de compra simulada permanece separado. Versão, conteúdo das ofertas, fator e validade são conferidos antes da aprovação; revisão substituída é rejeitada.

## Provas

- Dez chamadas reais ao TypeSafe, todas HTTP 200, dentro do limite explicitamente autorizado. Foram usados apenas dados fictícios. Payloads e respostas estão em `artifacts/final/jev-live-validation.json`; nenhuma chave está nesse arquivo.
- Os primeiros casos mostraram que somente domínio e valores eram evidência insuficiente. A versão final envia trecho capturado da oferta com contatos removidos, sem reduzir o limiar de probabilidade de 0,7.
- Caso final: fornecedor R$ 120,00 vs site R$ 100,00 → R$ 96,00 ajustados → fornecedor.
- Caso final: fornecedor R$ 130,00 vs site R$ 100,00 → R$ 104,00 ajustados → site.
- Custos ausentes → base comum de subtotal, sem inventar TCO.
- Evidência fraca → revisão necessária, sem escolha automática.
- Testes locais de regras e contrato HTTP passaram, incluindo centavos, limiar, custos desconhecidos, vencimento, persistência, aprovação/recusa, idempotência, revisão obsoleta, erro do provedor e ausência de efeitos de compra.
- Dois testes Playwright focados passaram: solicitação explícita, resumo/cálculo, aprovação persistida após reload, pendências e erro do Jev.
- Builds de produção da API e frontend passaram. Regressões de conclusão de cotação e compra simulada passaram.

Não foi feita compra real nem envio de mensagens a fornecedores durante esses testes. A qualidade da recomendação depende das evidências disponíveis; ofertas sem suporte suficiente continuam exigindo revisão.
