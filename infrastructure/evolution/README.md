# Compatibilidade de pareamento da Evolution

A imagem oficial v2.3.7 inclui Baileys `7.0.0-rc.9`, sem o tratamento de `companion_reg_refresh`. A recusa de pareamento pode ocorrer mesmo quando a mesma conta conecta normalmente no WhatsApp Web oficial. Isso corresponde ao relato [Evolution #2696](https://github.com/evolution-foundation/evolution-api/issues/2696).

A imagem local mantém a aplicação Evolution v2.3.7 e suas dependências originais, substituindo apenas a resolução do pacote `baileys` por uma árvore isolada em `/opt/nexo-baileys`, com lockfile próprio. Não altera o banco de negócio, o Telegram ou o código da API NestJS.

A correção usa Baileys `7.0.0-rc14` e o patch proposto em [Evolution #2727](https://github.com/evolution-foundation/evolution-api/pull/2727), com backport descrito em [Evolution #2759](https://github.com/evolution-foundation/evolution-api/pull/2759). São propostas ainda não incorporadas à release oficial. Nesta instalação, o pareamento real foi confirmado em 07/11/2026: a Evolution atingiu `state=open` e aceitou o envio de uma cotação de teste pelo fluxo de fallback da API NestJS.

Origem do patch: `ErgoCodes/evolution-api`, commit `d0198733da3cb133bd0c64d24fc4d1e7720696b1`, arquivo `patches/baileys+7.0.0-rc14.patch`. SHA-256 do arquivo original: `1808b91945f8cf91c00b035fc16f0fdcf1ff8b2eaec3506ae702f4226eb22a0d`. Autoria da proposta original: Clovis Coli Jr (`cloviscoli`); o patch reúne as correções upstream [Baileys #2765](https://github.com/WhiskeySockets/Baileys/pull/2765) e [#2602](https://github.com/WhiskeySockets/Baileys/pull/2602).

Adicionamos uma alteração complementar de uma linha no mesmo patch: `authState.creds.me?.id` ao montar o ACK de notificações anteriores ao login, conforme [Baileys #2749](https://github.com/WhiskeySockets/Baileys/pull/2749). Ela permite confirmar a notificação de atualização do QR antes de `creds.me` existir. As demais alterações são as da proposta pública citada.

```bash
podman compose build evolution
podman compose up -d --no-deps evolution
python3 scripts/whatsapp_pair.py
```

O build aplica o patch com `--error-on-fail` e executa `verify-pairing.mjs`. Esse teste carrega o módulo completo, verifica renovação do segredo, reuso da referência do QR e preservação de sessões já registradas. O visualizador local acompanha as alterações de QR durante a leitura; a página de chat pode mostrar uma imagem antiga após o servidor renovar o segredo.

Para voltar à imagem oficial, remova `build` do serviço `evolution`, troque `image` para `docker.io/evoapicloud/evolution-api:v2.3.7` e recrie somente esse serviço. Os volumes são preservados. Uma sessão ainda não pareada pode precisar de novo QR; voltar à imagem não restaura material de pareamento já renovado. Reavalie e remova este backport quando uma release oficial incluir as correções.
