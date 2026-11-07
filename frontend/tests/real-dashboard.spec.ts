import { expect, test } from "@playwright/test";
import { frontendStatus, mapReputationIndications, reputationMatchesOrigin } from "../app/api/status";

test("maps API completion to DONE without implying a purchase decision", async () => {
  expect(frontendStatus("concluida", 0)).toBe("DONE");
  expect(frontendStatus("decidida", 0)).toBe("DONE");
  expect(frontendStatus("recebida", 0)).toBe("CALLING");
  expect(reputationMatchesOrigin("loja.example", "shop.loja.example", true)).toBe(true);
  expect(reputationMatchesOrigin("loja.example", "pessoa-telegram.example", false)).toBe(false);
  expect(reputationMatchesOrigin("loja.example", "outra.example", true)).toBe(false);
});

test("maps Python reputation indications into dashboard fields without filtering snippets", () => {
  const timestamp = "2026-11-07T12:34:56.000Z";
  expect(mapReputationIndications([{ supplier_domain: "cascalho.example", url: "https://reviews.example/post/7", title: "Relato sobre fornecedor", snippet: "Trecho encontrado na fonte", timestamp, verified: false }])).toEqual([{
    supplier_domain: "cascalho.example", company_name: "Relato sobre fornecedor", title: "Relato sobre fornecedor", url: "https://reviews.example/post/7",
    excerpt: "Trecho encontrado na fonte", observed_at: timestamp,
  }]);
});

test("completed Telegram quote without source URL confirms by persisted quote id and cancels simulation", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  const id = "11111111-1111-4111-8111-111111111111";
  const quoteId = "22222222-2222-4222-8222-222222222222";
  const row: any = {
    id, version: 7, item: "Cascalho real", qty: 3, delivery_location: "São Paulo", status: "DONE", stage: "concluida",
    mode: "live", sources: [], reputations: [], reputation_indications: [], candidates: [], errors: [], blocked_sites: 0,
    selected_product_url: null, quote: { id: quoteId, supplier_name: "Fornecedor Telegram", product_name: "Cascalho", product_url: "", final_price: "12.00", shipping_fee: "5.00", final_tco: "41.00", event_id: "telegram-event", conditions: "" },
    purchase_simulation: null, audit: { additional_cost_total: "0.00" },
  };
  await page.route("**/api/godmode/dashboard", route => route.fulfill({ json: { data_mode: "real", total_runs: 1, runs: [row], metrics: { hard_savings: "0", cost_avoidance: "0", final_spend: "0", completed_count: 1, active_count: 0, verified_suppliers_count: 0, pending_tco_count: 0 } } }));
  let decisionBody: any; let decisionKey = ""; let decisionAttempts = 0; let cancelUrl = "";
  await page.route(`**/api/request/${id}/decision`, async route => {
    decisionAttempts++; decisionBody = route.request().postDataJSON(); decisionKey = route.request().headers()["idempotency-key"] || "";
    if (decisionAttempts > 1) row.purchase_simulation = { id: "sim-1", status: "awaiting_supplier", quote_id: quoteId };
    await route.fulfill({ status: decisionAttempts === 1 ? 503 : 201, json: decisionAttempts === 1 ? { detail: "Falha simulada" } : row.purchase_simulation });
  });
  await page.route(`**/api/request/${id}/purchase-simulation/cancel`, async route => { cancelUrl = route.request().url(); row.purchase_simulation = { id: "sim-1", status: "cancelled", quote_id: quoteId }; await route.fulfill({ json: row.purchase_simulation }); });
  await page.goto("/");
  await page.locator("#kanban").getByRole("button", { name: /Cascalho real/ }).click();
  const drawer = page.getByRole("dialog", { name: "Cascalho real" });
  await expect(drawer).toBeVisible();
  expect(pageErrors).toEqual([]);
  await drawer.getByRole("button", { name: "Quero comprar" }).click();
  const confirmation = page.getByRole("alertdialog", { name: "Confirmar compra simulada?" });
  await expect(confirmation).toContainText("Fornecedor Telegram");
  await expect(confirmation).toContainText("Cascalho");
  await expect(confirmation).toContainText("Nenhuma cobrança será feita");
  await confirmation.getByRole("button", { name: "Confirmar simulação" }).click();
  const firstKey = decisionKey;
  await expect(confirmation.getByRole("alert")).toContainText("Falha simulada");
  await confirmation.getByRole("button", { name: "Confirmar simulação" }).click();
  expect(decisionBody).toEqual({ quote_id: quoteId, version: 7, confirmed: true });
  expect(firstKey).toBeTruthy();
  expect(decisionKey).toBe(firstKey);
  await drawer.getByRole("button", { name: "Cancelar simulação" }).click();
  expect(cancelUrl).toContain(`/api/request/${id}/purchase-simulation/cancel`);
});

test("drawer displays partial supplier quote + market options in NEGOTIATING and internet preference in DONE", async ({ page }) => {
  const negId = "33333333-3333-4333-8333-333333333333";
  const doneId = "44444444-4444-4444-8444-444444444444";
  const supplierQuoteId = "55555555-5555-4555-8555-555555555555";
  const marketQuoteId = "66666666-6666-4666-8666-666666666666";
  const negotiatingRow: any = {
    id: negId, version: 2, item: "Monitor Dell 24", qty: 1, delivery_location: "13565090", status: "NEGOTIATING", stage: "comparação",
    quote_completion_state: "coletando", missing_fields: ["fees_cents", "destination_confirmed"],
    mode: "live", reputations: [], reputation_indications: [], candidates: [], errors: [], blocked_sites: 0,
    selected_product_url: null, market_average: "1049.00",
    sources: [{ quote_id: "77777777-7777-4777-8777-777777777777", supplier_name: "KaBuM!", supplier_domain: "kabum.com.br", product_name: "Monitor Dell 24 IPS", product_url: "https://www.kabum.com.br/produto/123", price: "1049.00", shipping_fee: null, availability: "Não confirmada", currency: "BRL", observed_at: "2026-11-07T15:00:00.000Z" }],
    quote: { supplier_name: "Fornecedor Telegram", product_name: "Monitor Dell 24", product_url: "", initial_price: "980.00", final_price: "980.00", shipping_fee: "0.00", fees_fee: null, final_tco: null, delivery_time: "5 dias", delivery_days: 5, available_qty: 10, payment_terms: "PIX, cartão em 12x sem juros", valid_until: "amanhã", conditions: "frete grátis" },
    purchase_simulation: null, preferred_market_quote_id: null, audit: null,
  };
  const doneRow: any = {
    id: doneId, version: 4, item: "Memória RAM DDR4", qty: 7, delivery_location: "13565090", status: "DONE", stage: "concluida",
    quote_completion_state: "concluida", missing_fields: [],
    mode: "live", reputations: [], reputation_indications: [], candidates: [], errors: [], blocked_sites: 0,
    selected_product_url: null, market_average: "389.00",
    sources: [{ quote_id: marketQuoteId, supplier_name: "Terabyteshop", supplier_domain: "terabyteshop.com.br", product_name: "Memória DDR4 3200MHz", product_url: "https://www.terabyteshop.com.br/produto/999", price: "389.00", shipping_fee: null, availability: "Não confirmada", currency: "BRL", observed_at: "2026-11-07T15:00:00.000Z" }],
    quote: { id: supplierQuoteId, supplier_name: "Fornecedor Telegram", product_name: "Memória RAM DDR4", product_url: "", initial_price: "350.00", final_price: "350.00", shipping_fee: "7.00", fees_fee: "0.00", final_tco: "2457.00", delivery_time: "4 dias", delivery_days: 4, available_qty: 10, payment_terms: "somente pix", conditions: "somente pix" },
    purchase_simulation: null, preferred_market_quote_id: null, audit: { final_price: "350.00", shipping_fee: "7.00", additional_cost_total: "0.00", quantity: 7, product_subtotal: "2450.00", initial_tco: "2457.00", final_tco: "2457.00", market_tco: null, hard_savings: null, cost_avoidance: null, delivery_days: 4, delivery_day_type: "unknown", justification: "Cotação confirmada pelo fornecedor no canal autorizado.", limitations: [], evidence_message_ids: [], audited_at: "2026-11-07T15:10:00.000Z" },
  };
  await page.route("**/api/godmode/dashboard", route => route.fulfill({ json: { data_mode: "real", total_runs: 2, runs: [negotiatingRow, doneRow], metrics: { hard_savings: "0", cost_avoidance: "0", final_spend: "2457.00", completed_count: 1, active_count: 1, verified_suppliers_count: 2, pending_tco_count: 0 } } }));
  let marketPayloads: any[] = [];
  await page.route(`**/api/request/${doneId}/market-preference`, async route => {
    const body = route.request().postDataJSON();
    marketPayloads.push(body);
    doneRow.preferred_market_quote_id = body.quote_id;
    doneRow.version += 1;
    await route.fulfill({ status: 201, json: doneRow });
  });
  await page.goto("/");
  await page.getByRole("region", { name: "Aguardando cotação" }).getByRole("button", { name: /Monitor Dell 24/ }).click();
  const negDrawer = page.getByRole("dialog", { name: "Monitor Dell 24" });
  await expect(negDrawer.getByRole("region", { name: "Composição do TCO" })).toContainText("Extração em andamento");
  await expect(negDrawer.getByRole("region", { name: "Composição do TCO" })).toContainText("R$ 980,00");
  await expect(negDrawer.getByRole("region", { name: "Composição do TCO" })).toContainText("5 dias");
  await expect(negDrawer.getByRole("region", { name: "Composição do TCO" })).toContainText("PIX, cartão em 12x sem juros");
  await expect(negDrawer.getByRole("region", { name: "Composição do TCO" })).toContainText("taxas adicionais, confirmação do CEP");
  await expect(negDrawer.getByRole("region", { name: "Opções do mercado" })).toContainText("KaBuM!");
  await expect(negDrawer.getByRole("region", { name: "Opções do mercado" })).toContainText("R$ 1.049,00");
  await negDrawer.getByRole("button", { name: "Fechar detalhes" }).click();

  await page.getByRole("region", { name: "Concluídas" }).getByRole("button", { name: /Memória RAM DDR4/ }).click();
  const doneDrawer = page.getByRole("dialog", { name: "Memória RAM DDR4" });
  await expect(doneDrawer.getByRole("region", { name: "Composição do TCO" })).toContainText("R$ 2.457,00");
  await expect(doneDrawer.getByRole("button", { name: "Quero comprar" })).toBeVisible();
  await doneDrawer.getByRole("button", { name: "Preferir esta opção da internet" }).click();
  expect(marketPayloads[0]).toEqual({ quote_id: marketQuoteId, version: 4 });
  await expect(doneDrawer.getByText("Preferência registrada: Terabyteshop")).toBeVisible();
  await doneDrawer.getByRole("button", { name: "Limpar preferência" }).click();
  expect(marketPayloads[1]).toEqual({ quote_id: null, version: 5 });
});

test("starts with real data only and combines metrics and Kanban", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("API conectada", { exact: true })).toBeVisible();
  const response = await page.request.get("/api/godmode/dashboard");
  const data = await response.json();
  expect(data.data_mode).toBe("real");
  expect(data.runs).toEqual([]);
  await expect(page.getByRole('log', { name: 'Eventos do agente' })).toHaveCount(0);
  await expect(page.getByLabel('Chave de API Tavily')).toHaveCount(0);
  await page.getByRole('link', { name: 'Configurações', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Conexões e contatos' })).toBeVisible();
  const integration = page.getByRole('region', { name: 'Provedor de busca' });
  await expect(integration.getByText('Aguardando chave', { exact: true })).toBeVisible();
  await integration.getByRole('button', { name: 'Conectar busca gratuita' }).click();
  await expect(integration.getByLabel('Chave de API Tavily')).toHaveAttribute('type', 'password');
  await expect(integration.getByRole('link', { name: 'painel da Tavily' })).toHaveAttribute('href', 'https://app.tavily.com');
  await integration.getByLabel('Chave de API Tavily').fill('not-sent-to-provider');
  await integration.getByRole('button', { name: 'Fechar configuração' }).click();
  await integration.getByRole('button', { name: 'Conectar busca gratuita' }).click();
  await expect(integration.getByLabel('Chave de API Tavily')).toHaveValue('');
  await integration.getByRole('button', { name: 'Fechar configuração' }).click();
  await page.getByRole("link", { name: "Voltar ao dashboard" }).click();
  await expect(page.getByRole("region", { name: "Indicadores de economia" }).getByText("R$ 0,00", { exact: true })).toHaveCount(3);
  const metrics = await page.getByRole("region", { name: "Indicadores de economia" }).boundingBox();
  const board = await page.locator("#kanban").boundingBox();
  expect(board!.y).toBeGreaterThan(metrics!.y + metrics!.height);
  await page.getByRole("button", { name: "Nova solicitação", exact: true }).click();
  await expect(page.getByLabel("Nome do item")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).not.toBeVisible();
});

test("submits a real discovery and shows evidence or an explicit collection failure", async ({ page }) => {
  test.setTimeout(90000);
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto("/");
  await expect(page.getByText("API conectada", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Nova solicitação", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Nova solicitação" });
  await dialog.getByLabel("Nome do item").fill("Mouse Logitech M170");
  await expect(dialog.locator("input:visible")).toHaveCount(3);
  await expect(dialog.getByLabel("Quantidade", { exact: true })).toHaveValue("1");
  await dialog.getByLabel("Local de entrega / CEP").fill("CEP 01000-000, SP");
  await dialog.getByRole("button", { name: "Pesquisar fornecedores reais" }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.locator("#kanban").getByRole("heading", { name: "Mouse Logitech M170" })).toBeVisible();

  await expect.poll(async () => (await (await page.request.get("/api/godmode/dashboard")).json()).runs[0].stage, { timeout: 65000 }).toMatch(/^(blocked|failed|negotiating)$/);
  const state = (await (await page.request.get("/api/godmode/dashboard")).json()).runs[0];
  expect(state.data_mode).toBe("real");
  expect(state.quote).toBeNull();
  expect(state.hard_savings).toBeNull();
  for (const source of state.sources) {
    expect(source.product_url).toMatch(/^https?:\/\//);
    expect(Number(source.price)).toBeGreaterThan(0);
    expect(source.evidence_sha256).toHaveLength(64);
    expect(["schema.org/Product.offers", "schema.org/Product.microdata", "OpenGraph.product:price", "merchant_html/kalunga.product_cash_price"]).toContain(source.extraction_method);
  }
  if (state.stage === "negotiating") expect(state.sources.length).toBeGreaterThanOrEqual(3);
  else await expect(page.getByRole("button", { name: "Tentar novamente", exact: true })).toBeVisible();
  const history = await (await page.request.get(`/api/godmode/events/history?run_id=${state.id}`)).json();
  const lastId = history.at(-1).id;
  const frame = await page.evaluate(async ({ id, lastId }) => {
    const abort = new AbortController(); const timer = setTimeout(() => abort.abort(), 10000);
    try {
      const response = await fetch(`/api/godmode/events?run_id=${id}`, { headers: { "Last-Event-ID": String(lastId - 1) }, signal: abort.signal });
      if (!response.headers.get("content-type")?.includes("text/event-stream")) throw new Error("Expected SSE");
      const reader = response.body!.getReader(); let text = "";
      while (!text.includes("event: log")) { const part = await reader.read(); if (part.done) throw new Error("Missing event"); text += new TextDecoder().decode(part.value); }
      await reader.cancel(); return text;
    } finally { clearTimeout(timer); abort.abort(); }
  }, { id: state.id, lastId });
  expect(frame).toContain(`id: ${lastId}\n`);
  await page.reload();
  await expect(page.locator("#kanban").getByRole("heading", { name: "Mouse Logitech M170" })).toBeVisible();
  await page.locator("#kanban").getByRole("button", { name: /Mouse Logitech M170/ }).click();
  const drawer = page.getByRole("dialog", { name: "Mouse Logitech M170" });
  await expect(drawer).toBeVisible();
  await expect(drawer.getByRole("region", { name: "Composição do TCO" })).toBeVisible();
  const download = page.waitForEvent("download");
  await drawer.getByRole("button", { name: "Exportar evidências" }).click();
  expect((await download).suggestedFilename()).toBe(`nexo-evidencias-${state.id}.json`);
  await drawer.getByRole("button", { name: "Acompanhar conversa ao vivo" }).click();
  const chat = page.getByRole("dialog", { name: /Negociação/ });
  await expect(chat).toBeVisible();
  await expect(chat.getByRole("log", { name: "Conversa com fornecedores" })).toBeVisible();
  await expect(chat.getByText(/Ainda não há mensagens/)).toBeVisible();
  const polled = page.waitForResponse(response => response.url().includes(`/api/chat/${state.id}`));
  await polled;
  await chat.getByRole("button", { name: "Fechar conversa" }).click();
  await expect(chat).not.toBeVisible();
  await drawer.getByRole("button", { name: "Fechar detalhes" }).click();
  await expect(drawer).not.toBeVisible();
  await page.screenshot({ path: "test-results/real-dashboard-desktop.png", fullPage: true });
  expect(errors).toEqual([]);
});

test("mobile layout fits and lost API access does not introduce demo prices", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(page.getByText("API conectada", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: "test-results/real-dashboard-mobile.png", fullPage: true });
  await page.route("**/api/godmode/dashboard", route => route.abort());
  await page.getByRole("button", { name: "Atualizar dados" }).click();
  await expect(page.getByText("Sem conexão", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Nova solicitação", exact: true })).toBeDisabled();
  await expect(page.getByText("Demonstração local", { exact: true })).toHaveCount(0);
});

test("sandbox observer renders both roles, polls, and stops when closed", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("API conectada", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Testar no meu Telegram" }).click();
  const form = page.getByRole("dialog", { name: "Teste ao vivo no Telegram" });
  await expect(form.locator("input:visible")).toHaveCount(3);
  await form.getByLabel("Nome do item").fill("Mouse Logitech M170");
  await form.getByLabel("Local de entrega / CEP").fill("CEP 01001-000, SP");
  const sent = page.waitForRequest(request => request.url().endsWith("/api/request") && request.method() === "POST");
  await form.getByRole("button", { name: "Iniciar demonstração ao vivo" }).click();
  expect((await sent).postDataJSON()).toEqual({ item: "Mouse Logitech M170", mode: "sandbox", qty: 1, delivery_location: "CEP 01001-000, SP" });
  await expect(form).not.toBeVisible();
  const row = (await (await page.request.get("/api/godmode/dashboard")).json()).runs[0];
  expect(row.mode).toBe("sandbox");
  let polls = 0;
  await page.route(`**/api/chat/${row.id}`, async route => {
    polls++;
    await route.fulfill({ json: [
      { id: 9001, request_id: row.id, supplier_domain: "fixture.example", sender_type: "AI", text: "Mensagem de IA para verificar a interface.", timestamp: new Date().toISOString(), delivery_status: "sent" },
      { id: 9002, request_id: row.id, supplier_domain: "fixture.example", sender_type: "SUPPLIER", text: "Resposta humana para verificar a interface.", timestamp: new Date().toISOString(), delivery_status: "received" },
    ] });
  });
  const card = page.locator("#kanban article").filter({ hasText: "SANDBOX · seu Telegram" });
  await card.getByRole("button", { name: /Mouse Logitech M170/ }).click();
  const drawer = page.getByRole("dialog", { name: "Mouse Logitech M170" });
  await expect(drawer).toBeVisible();
  await drawer.getByRole("button", { name: "Acompanhar conversa ao vivo" }).click();
  const modal = page.getByRole("dialog", { name: /SANDBOX/ });
  await expect(modal).toBeVisible();
  const ai = modal.locator("article").filter({ hasText: "Mensagem de IA para verificar a interface." });
  const supplier = modal.locator("article").filter({ hasText: "Resposta humana para verificar a interface." });
  await expect(ai).toHaveClass(/bg-blue-600/);
  await expect(supplier).toHaveClass(/bg-slate-200/);
  expect((await ai.boundingBox())!.x).toBeLessThan((await supplier.boundingBox())!.x);
  await expect.poll(() => polls, { timeout: 6000 }).toBeGreaterThanOrEqual(2);
  await modal.getByRole("button", { name: "Fechar conversa" }).click();
  const stopped = polls;
  await page.waitForTimeout(3300);
  expect(polls).toBe(stopped);
});


test("drawer shows audited quantity, freight and traceable savings", async ({ page }) => {
  const source = { product_url: "https://example.com/product", supplier_name: "Test fixture", supplier_domain: "example.com", price: "100.00", currency: "BRL", product_name: "Produto do teste de interface", observed_at: new Date().toISOString() };
  const audit = { shipping_savings: "15.00", tco_savings: "75.00", final_price: "80.00", shipping_fee: "5.00", quantity: 2, product_subtotal: "160.00", initial_tco: "240.00", final_tco: "165.00", market_tco: "200.00", hard_savings: "60.00", cost_avoidance: "40.00", delivery_days: 5, delivery_day_type: "business", justification: "Cotação auditada com frete e quantidade confirmados.", limitations: [], evidence_message_ids: [2, 4], audited_at: new Date().toISOString() };
  const row = { id: 901, item: "Produto do teste de interface", qty: 2, mode: "live", delivery_location: "São Paulo", status: "DONE", stage: "completed", target_basis: "complete_tco", tco_base: "200.00", target_price: "170.00", market_average: "100.00", hard_savings: "60.00", cost_avoidance: "40.00", audit, quote: { ...audit, conditions: "Pix", delivery_time: "5 dias úteis" }, candidates: [], errors: [], sources: [source], reputations: [], selected_product_url: source.product_url };
  await page.route("**/api/godmode/dashboard", route => route.fulfill({ json: { data_mode: "real", total_runs: 1, runs: [row], metrics: { hard_savings: "60.00", cost_avoidance: "40.00", final_spend: "165.00", completed_count: 1, active_count: 0, verified_suppliers_count: 1, pending_tco_count: 0 } } }));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  const metrics = page.getByRole("region", { name: "Indicadores de economia" });
  await expect(metrics.getByRole("heading", { name: "Final Negotiated Amount" })).toBeVisible();
  await page.locator("#kanban").getByRole("button", { name: /Produto do teste de interface/ }).click();
  const drawer = page.getByRole("dialog", { name: "Produto do teste de interface" });
  await expect(drawer.getByRole("region", { name: "Composição do TCO" }).getByText("R$ 165,00", { exact: true })).toBeVisible();
  await expect(drawer.getByText("Cotação auditada com frete e quantidade confirmados.")).toBeVisible();
  await expect(drawer.getByRole("link", { name: "Produto na loja" })).toHaveAttribute("href", source.product_url);
  expect(Math.round((await drawer.boundingBox())!.width)).toBeLessThanOrEqual(390);
  await page.keyboard.press("Escape");
  await expect(drawer).not.toBeVisible();
});
