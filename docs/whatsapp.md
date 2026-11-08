# WhatsApp e fallback Telegram — Nexo

Os arquivos foram editados diretamente. O negócio continua em `better-sqlite3`; PostgreSQL e Redis são exclusivos da Evolution. Telegram e `/requests` mantêm seus contratos. Mensagens aparecem em `GET /requests/:id/messages` com `channel`, `supplier_id`, `supplier_name` e `chat_id`. Requests incluem `whatsapp_pending` por fornecedor; cotações têm `channel` e identidade própria. A migração adiciona `channel` (Telegram por padrão) e `external_message_id`, sem apagar dados.

## Subir e conectar

O Compose constrói `localhost/nexo-evolution:2.3.7-pairing-1`, baseada em `docker.io/evoapicloud/evolution-api:v2.3.7`, com a correção de pareamento descrita em [infrastructure/evolution/README.md](../infrastructure/evolution/README.md). A imagem antiga `atendai/evolution-api:v2.1.2` retornou acesso negado durante a instalação; a versão v2.3.7 foi confirmada nas releases oficiais. Os nomes completos das imagens também evitam a resolução interativa de registros no Podman.

1. Copie `.env.example` para `.env` **somente se ainda não existir**. Em um `.env` existente, acrescente as novas variáveis. Preencha `WHATSAPP_API_KEY`, `WHATSAPP_WEBHOOK_SECRET`, `VOICE_WEBHOOK_SECRET`, `INTERNAL_API_TOKEN` com valores distintos, além da chave Gemini. Configure `WHATSAPP_SUPPLIER_NUMBER` (ou `WHATSAPP_TEST_SUPPLIER_NUMBER`) apenas com um contato autorizado. Para o runtime local, `WHATSAPP_API_URL=http://127.0.0.1:8080`; dentro do Compose, a API usa `http://evolution:8080`. `WHATSAPP_INSTANCE_NAME=nexo`.
2. Execute `podman compose up -d --build` (ou `docker compose up -d --build`). A API não depende da disponibilidade da Evolution para iniciar ou atender Telegram.
3. No Compose, a API cria a instância se necessário e configura o webhook automaticamente para `http://api:4000/webhook/whatsapp`, com o segredo de autenticação. Não execute o relay de desenvolvimento do host quando estiver usando o Compose. Para parear sem instalar Python no computador:

```bash
docker compose --profile pairing up -d --build whatsapp-pairing
```

Abra `http://127.0.0.1:8766` e leia o QR com o WhatsApp da Nexo, em **Aparelhos conectados → Conectar aparelho**. O visualizador atualiza o código e não revela a chave da API. Depois de conectar, pode encerrar apenas o visualizador: `docker compose --profile pairing stop whatsapp-pairing`.

Os comandos abaixo são alternativas manuais para administrar a Evolution:

```bash
curl -fsS http://localhost:8080/instance/create \
  -H "apikey: $WHATSAPP_API_KEY" -H 'Content-Type: application/json' \
  -d "{\"instanceName\":\"$WHATSAPP_INSTANCE_NAME\",\"integration\":\"WHATSAPP-BAILEYS\",\"qrcode\":true}"

curl -fsS "http://localhost:8080/webhook/set/$WHATSAPP_INSTANCE_NAME" \
  -H "apikey: $WHATSAPP_API_KEY" -H 'Content-Type: application/json' \
  -d "{\"webhook\":{\"enabled\":true,\"url\":\"http://api:4000/webhook/whatsapp\",\"headers\":{\"x-whatsapp-webhook-secret\":\"$WHATSAPP_WEBHOOK_SECRET\"},\"byEvents\":false,\"base64\":false,\"events\":[\"MESSAGES_UPSERT\"]}}"

curl -fsS "http://localhost:8080/instance/connect/$WHATSAPP_INSTANCE_NAME" \
  -H "apikey: $WHATSAPP_API_KEY"
```

Para acompanhar as mudanças de QR durante o pareamento, execute em outro terminal:

```bash
python3 scripts/whatsapp_pair.py
```

Abra `http://127.0.0.1:8766`; a imagem acompanha a rotação do QR automaticamente, sem revelar a chave da API. Encerre o visualizador com Ctrl+C após o pareamento. O script não cria a instância nem configura o webhook: execute antes os comandos acima.

Escaneie o QR retornado (ou use o visualizador local) com o WhatsApp do número usado pela Nexo, em **Aparelhos conectados**. A API usa `POST /message/sendText/{instance}` com `apikey` e `{number,text}`. O status local `sent` significa que a Evolution retornou um ID de aceitação; não representa confirmação de leitura ou entrega ao aparelho.

## Teste por curl

Para usar o contato padrão em novas solicitações, configure explicitamente `WHATSAPP_SUPPLIER_NUMBER`. O número é cadastrado como `Fornecedor configurado` com ID estável; nenhuma relação é inferida pelo nome. `WHATSAPP_TEST_SUPPLIER_NUMBER` continua disponível para testes locais. Com `VAPI_PUBLIC_KEY` e `VAPI_ASSISTANT_ID` configurados, a API envia primeiro um convite de chamada WebRTC pelo WhatsApp, aguarda `VOICE_ANSWER_TIMEOUT_SECONDS` (120 segundos) e só então inicia a cotação por texto. Uma chamada atendida suspende o fallback e sua transcrição segue para o WhatsApp ao encerrar. Sem configuração de voz, começa diretamente por texto. Uma resposta reconhecida cancela o fallback; sem resposta, a API usa o chat Telegram somente se houver exatamente um chat autorizado em `TELEGRAM_ALLOWED_CHAT_IDS`, após `WHATSAPP_TELEGRAM_FALLBACK_SECONDS` (60 segundos por padrão). A deadline fica no SQLite e sobrevive a reinícios. Envio incerto não é repetido; ausência de uma configuração Evolution é registrada como atenção e não é tratada como envio. A sessão WebRTC é aberta pelo fornecedor no link `/call/[id]`; não há discagem telefônica automática nesse modo.

Use apenas um número sob seu controle para testar envio; o teste HTTP automatizado usa stubs e não envia mensagens reais. Copie o `id` retornado pela criação para `REQUEST_ID`. Os valores de voz abaixo são os segredos definidos no `.env`.

```bash
curl -fsS http://localhost:4000/requests \
  -H 'Content-Type: application/json' \
  -d '{"product":"SSD 1TB","specs":{},"qty":2,"destination":"01001-000"}'

REQUEST_ID='cole-o-uuid-da-solicitacao'
SUPPLIER_NUMBER='5511999999999'

# Cadastro do contato no contexto da solicitação (DDI, DDD e número).
curl -fsS "http://localhost:4000/requests/$REQUEST_ID/whatsapp" \
  -H "Authorization: Bearer $INTERNAL_API_TOKEN" -H 'Content-Type: application/json' \
  -d "{\"supplier_id\":\"loja-1\",\"name\":\"Loja Teste\",\"number\":\"$SUPPLIER_NUMBER\"}"

# Simula a chamada sem resposta e dispara o WhatsApp.
curl -fsS http://localhost:4000/webhook/voice \
  -H "x-voice-webhook-secret: $VOICE_WEBHOOK_SECRET" -H 'Content-Type: application/json' \
  -d "{\"request_id\":\"$REQUEST_ID\",\"supplier_id\":\"loja-1\",\"call_id\":\"demo-call-1\",\"status\":\"no-answer\",\"quote_completed\":false}"

# Recebe proposta parcial: deve ir para comparação e perguntar só as pendências.
curl -fsS http://localhost:4000/webhook/whatsapp \
  -H "x-whatsapp-webhook-secret: $WHATSAPP_WEBHOOK_SECRET" -H 'Content-Type: application/json' \
  -d "{\"event\":\"messages.upsert\",\"instance\":\"$WHATSAPP_INSTANCE_NAME\",\"data\":{\"key\":{\"id\":\"demo-in-1\",\"remoteJid\":\"$SUPPLIER_NUMBER@s.whatsapp.net\",\"fromMe\":false},\"message\":{\"conversation\":\"Sou a Loja Teste. Confirmo SSD 1TB e entrega no CEP 01001-000. Preço unitário R\$ 350,00; temos 10 unidades.\"}}}"

# Completa os dados na mesma conversa.
curl -fsS http://localhost:4000/webhook/whatsapp \
  -H "x-whatsapp-webhook-secret: $WHATSAPP_WEBHOOK_SECRET" -H 'Content-Type: application/json' \
  -d "{\"event\":\"messages.upsert\",\"instance\":\"$WHATSAPP_INSTANCE_NAME\",\"data\":{\"key\":{\"id\":\"demo-in-2\",\"remoteJid\":\"$SUPPLIER_NUMBER@s.whatsapp.net\",\"fromMe\":false},\"message\":{\"conversation\":\"Frete total R\$ 20,00, taxas zero e prazo de 3 dias.\"}}}"

curl -fsS "http://localhost:4000/requests/$REQUEST_ID"
curl -fsS "http://localhost:4000/requests/$REQUEST_ID/messages"
```

Repita o mesmo `demo-in-2`: retorna `duplicate` e não cria mensagem/proposta/envio adicional. Repita `demo-call-1` com `busy`, `failed` ou `hangup`: o envio do fallback continua único por chamada. Uma chamada com `quote_completed: true` não gera fallback, inclusive em eventos posteriores da mesma chamada. Não envie essa confirmação até que a cotação tenha sido persistida com sucesso pelo serviço de voz. Quando houver uma proposta elegível em `quotes` com `event_id=voice:<call_id>`, ela também impede o fallback.

Para testar o filtro do próprio bot, altere o payload para `fromMe: true`: retorna `ignored: from-me`. Sem o header secreto, retorna HTTP 401. Grupos, mídias sem texto, remetentes desconhecidos e outras instâncias são ignorados.

Se o mesmo número estiver vinculado a várias solicitações abertas, o fornecedor precisa responder citando uma mensagem enviada da solicitação correta. A referência pode vir em `data.message.extendedTextMessage.contextInfo.stanzaId` ou em `data.contextInfo.stanzaId`, inclusive quando o texto está em `data.message.conversation`. Ambos os formatos são aceitos. Sem esse contexto, o webhook retorna `ambiguous-request` e não atribui a proposta à solicitação errada. JIDs de telefone `@s.whatsapp.net` são aceitos. Para conversas `@lid`, o telefone é obtido de `key.remoteJidAlt`, quando ele contém um JID válido `@s.whatsapp.net`; JIDs `@lid` sem esse telefone e grupos continuam sendo ignorados.

## Conectar o encerramento de voz real

Configure o provedor de voz ou seu adaptador para enviar os eventos terminais ao **NestJS**, em `/webhook/voice`, com o header `x-voice-webhook-secret`. Se o provedor for externo, exponha apenas essa rota via túnel/proxy para a porta 4000. O serviço `agents` do Compose executa `app.agent_service`; o antigo `app.main`/webhook Python usa IDs inteiros e outro banco. Ele não deve encaminhar seus IDs diretamente como se fossem os UUIDs de `/requests`.

O novo endpoint aceita o evento normalizado mostrado acima ou este envelope Vapi:

```json
{
  "message": {
    "type": "end-of-call-report",
    "endedReason": "customer-ended-call",
    "call": {
      "id": "id-estavel-da-chamada",
      "metadata": {
        "request_id": "uuid-da-solicitacao-Nest",
        "supplier_id": "loja-1",
        "quote_completed": false
      }
    }
  }
}
```

A API preserva o endpoint e callbacks de voz para integrações existentes. O fluxo automático de novos contatos não inicia chamadas de voz. Para callbacks já em andamento, inclua `request_id` e `supplier_id`; o contato deve estar cadastrado antes. O adaptador deve marcar `quote_completed: true` quando houver cotação concluída; uma proposta parcial não deve ser marcada como concluída. Status normalizados aceitos: `busy`, `no-answer`, `failed`, `hangup`, `completed`, `ended`. Também são reconhecidos `customer-busy`, `customer-did-not-answer`, `call-start-error`, `customer-ended-call`, `assistant-ended-call`, `silence-timed-out` e `max-duration-reached`. Outros estados não disparam contato. Chamadas persistidas em `whatsapp_contact_flow` continuam sendo consultadas sem iniciar uma nova ligação. Um estado de início incerto não gera nova chamada nem contato automático.

## Persistência, falhas e testes automatizados

API, agentes e frontend usam `restart: unless-stopped`, assim como a infraestrutura da Evolution. Isso permite ao runtime reiniciar containers após falhas; containers parados explicitamente continuam parados. Se a aplicação estiver indisponível, confira `podman compose ps -a` e inicie os serviços com `podman compose up -d`. Antes de gerar outro QR, consulte `/instance/connectionState/{instance}`: uma sessão persistida pode reconectar automaticamente, sem novo pareamento.

- `whatsapp_contacts`: vínculo imutável entre número, fornecedor e solicitação.
- `whatsapp_delivery`: chave de idempotência, conteúdo, ID retornado e estado do envio.
- `whatsapp_updates`: inbox persistente e deduplicada por instância/número/ID; até três tentativas de interpretação, retomadas após reinício, em ordem por conversa.
- `whatsapp_quote_state`: dados parciais por fornecedor, inclusive informações recebidas antes do preço.
- `whatsapp_voice_calls`: identidade da chamada e conclusão de cotação preservada entre eventos.
- `whatsapp_contact_flow`: canal inicial e deadline durável do fallback WhatsApp → Telegram.

Cotação e resposta preparada são gravadas na mesma transação SQLite. A rede nunca é chamada dentro de uma transação. O agente recebe apenas o histórico do fornecedor e canal em questão. `parsed.pending` é conciliado com os campos acumulados para não repetir perguntas já respondidas. Uma proposta sem preço continua no estado parcial; com preço válido, `addQuote` atualiza o Kanban para `comparação`, mantendo a regra existente de elegibilidade para decisão.

Envios `failed` (rejeição HTTP 4xx) ou `uncertain` (timeout, desconexão, HTTP 5xx, resposta sem ID ou reinício durante envio) ficam registrados e não são repetidos automaticamente. Isso evita duplicar mensagens quando a Evolution pode ter aceitado o envio. Confira a Evolution antes de uma nova tentativa operacional. Após três falhas de interpretação, a inbox fica `exhausted`; os dados e a mensagem recebida continuam disponíveis no SQLite.

```bash
cd api
npm ci
npm run test:whatsapp
cd ..
python3 scripts/test_whatsapp_webhook_gateway.py
# Regressão existente de Telegram e requests (requer python3 para o gateway):
node scripts/smoke.mjs
```

O teste de WhatsApp usa apenas stubs HTTP e SQLite temporário: não exige Gemini, QR Code, Evolution nem número real. Referências: [webhook da Evolution](https://github.com/evolution-foundation/evolution-docs/blob/main/docs/02-Configuration/Webhooks.md), [configuração por instância](https://docs.evoapicloud.com/api-reference/webhook/set).
