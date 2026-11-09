<p align="center">
  <a href="https://hub.digitaly.tech/hackathon-03/">
    <img src="docs/assets/selo-campea-hackathon-03.png" alt="Campeã da Guerra das IAs · Hackathon Digitaly 03 · Equipe Mitada" width="100%">
  </a>
</p>

<p align="center">
  🏆 <b>Equipe campeã</b> da <a href="https://hub.digitaly.tech/hackathon-03/">Guerra das IAs · Hackathon Digitaly 03</a><br>
  07 e 08 de novembro de 2026 · Digitaly HUB, São Carlos
</p>

# Nexo · Procurement Intelligence

O Nexo é uma plataforma de inteligência de compras que pesquisa preços, negocia com fornecedores e apresenta o impacto econômico das opções disponíveis. O objetivo é reunir pesquisa, conversa e comparação em um único workspace para apoiar a decisão do comprador.

## Como funciona

1. **Solicitação:** o comprador informa produto, especificações, quantidade e CEP de entrega.
2. **Pesquisa de mercado:** os agentes usam Tavily para localizar ofertas e extrair preços com fontes e evidências. Os resultados alimentam a comparação mesmo quando chegam após o encerramento da negociação.
3. **Contato com o fornecedor:** a aplicação envia um convite para chamada no navegador com Vapi/WebRTC. Sem atendimento em **2 minutos**, segue por texto no WhatsApp; após mais **1 minuto sem resposta**, aciona o Telegram. Uma resposta fixa o canal e cancela o fallback. A transcrição da chamada é enviada ao WhatsApp.
4. **Negociação:** o agente coleta preço, frete, taxas, prazo e estoque. Por texto, considera contrapropostas, respeita recusas e permite até três pedidos de melhoria. A confirmação do fornecedor conclui a cotação e atualiza o Kanban.
5. **Análise e decisão:** o comprador compara ofertas no Dashboard / Análise Econômica e escolhe a opção desejada. Confirmar uma cotação não autoriza uma compra; a decisão continua humana.

## Recursos implementados

- Workspace com autenticação, solicitações, **Kanban atualizado a cada 2 segundos** e conversa ao vivo.
- Pesquisa de ofertas reais, comparação de propostas e consulta de reputação com indicação das fontes e das informações não verificadas.
- Negociação por voz, WhatsApp e Telegram, com histórico persistido e controle de prioridade entre os canais.
- Dashboard econômico com **custo do fornecedor, menor custo** e gráficos comparativos. O custo total considera quantidade, frete e taxas quando esses valores estão confirmados.
- Histórico temporal de preços com consulta ao **Buscapé**, seleção de períodos de 30/60/90 dias e análise de timing de compra. Quando faltam dados, a interface informa a indisponibilidade; não inventa uma série histórica.
- Recomendação de compra com Jev/TypeSafe, revisão humana, histórico de decisões e simulação de compra separada de pagamentos reais.

## Executar com Docker

```sh
cp .env.example .env
```

Preencha no `.env` as credenciais das integrações utilizadas: Tavily, Gemini ou Groq, Vapi, WhatsApp/Evolution e Telegram, além dos tokens internos indicados no exemplo. Depois:

```sh
docker compose up -d --build
```

Abra [localhost:3000](http://localhost:3000). Para conectar o WhatsApp:

```sh
docker compose --profile pairing up -d --build whatsapp-pairing
```

Acesse [127.0.0.1:8766](http://127.0.0.1:8766) e escaneie o QR em **WhatsApp → Aparelhos conectados**. As cotações e a sessão são preservadas em volumes Docker.

Chamadas em outro aparelho e webhooks Telegram precisam de HTTPS. O projeto inclui um túnel temporário opcional:

```sh
docker compose -f compose.yaml -f compose.public.yaml up -d --build
```

Esse túnel publica a aplicação durante a demonstração. Seu endereço aparece nos logs do serviço `tunnel` e é descoberto pela API para os convites e o webhook Telegram.

## Arquitetura

- **Frontend:** Next.js 15, TypeScript e Tailwind CSS.
- **API de negócio:** NestJS e SQLite, responsável por solicitações, propostas, conversas e decisões.
- **Agentes:** Python, LangGraph e modelos estruturados, com checkpoints próprios e resultados enviados à API por callbacks autenticados.
- **Integrações:** Tavily, Vapi, Evolution API, Telegram, Buscapé e Jev/TypeSafe.

Detalhes: [WhatsApp](docs/whatsapp.md), [análise temporal](docs/price-timing.md), [histórico](docs/historico.md) e [ações de solicitações](docs/acoes-solicitacoes.md).
