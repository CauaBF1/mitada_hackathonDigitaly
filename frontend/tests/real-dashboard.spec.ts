import { expect, test } from "@playwright/test";

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
