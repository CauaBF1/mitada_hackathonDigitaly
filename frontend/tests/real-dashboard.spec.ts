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
  await page.route("**/api/auth/me", route => route.fulfill({ json: { user: { id: "u-1", name: "Teste", email: "teste@nexo.local", created_at: "2026-11-07T00:00:00.000Z" } } }));
  await page.route("**/api/godmode/dashboard", route => route.fulfill({ json: { data_mode: "real", total_runs: 1, runs: [row], metrics: { hard_savings: "0", cost_avoidance: "0", final_spend: "0", completed_count: 1, active_count: 0, verified_suppliers_count: 0, pending_tco_count: 0 } } }));
  let decisionBody: any; let decisionKey = ""; let decisionAttempts = 0; let cancelUrl = "";
  await page.route(`**/api/request/${id}/decision`, async route => {
    decisionAttempts++; decisionBody = route.request().postDataJSON(); decisionKey = route.request().headers()["idempotency-key"] || "";
    if (decisionAttempts > 1) row.purchase_simulation = { id: "sim-1", status: "awaiting_supplier", quote_id: quoteId };
    await route.fulfill({ status: decisionAttempts === 1 ? 503 : 201, json: decisionAttempts === 1 ? { detail: "Falha simulada" } : row.purchase_simulation });
  });
  await page.route(`**/api/request/${id}/purchase-simulation/cancel`, async route => { cancelUrl = route.request().url(); row.purchase_simulation = { id: "sim-1", status: "cancelled", quote_id: quoteId }; await route.fulfill({ json: row.purchase_simulation }); });
  await page.goto("/dashboard");
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

test("Jev purchase recommendation is explicit, shows cent math, and records the user's answer", async ({ page }) => {
  const id = "12121212-1212-4212-8212-121212121212";
  const quoteId = "23232323-2323-4323-8323-232323232323";
  const row: any = {
    id, version: 9, item: "Teclado de teste", qty: 1, delivery_location: "São Paulo", status: "DONE", stage: "concluida", mode: "live",
    sources: [], reputations: [], reputation_indications: [], candidates: [], errors: [], blocked_sites: 0, selected_product_url: null,
    quote: { id: quoteId, supplier_name: "Fornecedor cotado", product_name: "Teclado", final_price: "123.00", shipping_fee: "0.00", final_tco: "123.00", delivery_time: "3 dias", conditions: "" },
    purchase_simulation: null, audit: { final_tco: "123.00", additional_cost_total: "0.00" },
  };
  await page.route("**/api/auth/me", route => route.fulfill({ json: { user: { id: "u-1", name: "Teste", email: "teste@nexo.local", created_at: "2026-11-08T00:00:00.000Z" } } }));
  await page.route("**/api/godmode/dashboard", route => route.fulfill({ json: { data_mode: "real", total_runs: 1, runs: [row], metrics: { hard_savings: "0", cost_avoidance: "0", final_spend: "123.00", completed_count: 1, active_count: 0, verified_suppliers_count: 0, pending_tco_count: 0 } } }));
  let recommendationCalls = 0; let approvalBody: any; let recommendationPayload: any;
  await page.route(`**/api/request/${id}/purchase-recommendation`, async route => {
    recommendationCalls++;
    recommendationPayload = {
      review_id: "review-jev-1", version: 9, offer_hash: "hash-1", recommendation: "supplier", verdict: "Fornecedor dentro do limite de custo definido.", reason: "confirmed_supplier_within_max_premium", explanation: "O total do fornecedor está R$ 5,00 acima da oferta confiável.", policy_version: "supplier-premium-v1", supplier_max_premium_percent: 5, supplier_premium_allowed: true, premium_limit_cents: 27300, savings_or_premium_cents: 500, savings_or_premium_percent: 1.92, comparison_provisional: false,
      actual_supplier_tco_cents: 26500, actual_supplier_comparison_cents: 26500,
      best_market_offer_id: "market-cheap", best_market_tco_cents: 24500, most_reliable_market_offer_id: "market-reliable", most_reliable_market_tco_cents: 26000,
      comparator_market_offer_id: "market-reliable", comparator_market_tco_cents: 26000, supplier_offer_id: "supplier-1", selected_offer_id: "supplier-1", threshold_market_tco_cents: 27300,
      comparison_basis: "complete_tco", comparison_supplier_cents: 26500, comparator_market_cents: 26000, pending_checks: [],
      candidates: [
        { offer_id: "supplier-1", supplier: "Fornecedor cotado", channel: "telegram", source_url: null, unit_cents: 25000, product_subtotal_cents: 25000, shipping_cents: 1500, fees_cents: 0, lead_days: 2, available_qty: 10, tco_cents: 26500, comparison_amount_cents: 26500, eligible: true, equivalence_probability: 0.56, evidence_probability: 0.33, comparable: true, reliable: true, is_completed_supplier: true, pending_checks: [] },
        { offer_id: "market-cheap", supplier: "Loja com menor preço", channel: "market", source_url: "https://shop.example/cheap", unit_cents: 24500, product_subtotal_cents: 24500, shipping_cents: 0, fees_cents: 0, lead_days: 3, available_qty: 2, tco_cents: 24500, comparison_amount_cents: 24500, eligible: true, equivalence_probability: 0.95, evidence_probability: 0.55, comparable: true, reliable: false, adjusted_tco_cents: null },
        { offer_id: "market-reliable", supplier: "Loja mais confiável", channel: "market", source_url: "https://shop.example/reliable", unit_cents: 26000, product_subtotal_cents: 26000, shipping_cents: 0, fees_cents: 0, lead_days: 3, available_qty: 4, tco_cents: 26000, comparison_amount_cents: 26000, eligible: true, equivalence_probability: 0.96, evidence_probability: 0.92, comparable: true, reliable: true, adjusted_tco_cents: null },
      ],
    };
    await route.fulfill({ json: recommendationPayload });
  });
  await page.route(`**/api/request/${id}/purchase-recommendation/approval`, async route => {
    approvalBody = route.request().postDataJSON();
    row.latest_purchase_recommendation = { ...recommendationPayload, approval: { approved: true, selected_offer_id: "supplier-1", at: "2026-11-08T10:00:00.000Z" }, stale: false };
    await route.fulfill({ json: { review_id: "review-jev-1", approved: true, selected_offer_id: "supplier-1", version: 9, latest_purchase_recommendation: row.latest_purchase_recommendation } });
  });
  await page.goto("/dashboard");
  await page.locator("#kanban article").filter({ hasText: "Teclado de teste" }).locator('button[aria-pressed]').click();
  const drawer = page.getByRole("dialog", { name: "Teclado de teste" });
  await page.setViewportSize({ width: 1440, height: 700 });
  await expect(drawer.getByRole("button", { name: "Ver recomendação de compra" })).toBeVisible();
  const recommendationButtonBox = await drawer.getByRole("button", { name: "Ver recomendação de compra" }).boundingBox();
  expect(recommendationButtonBox).not.toBeNull();
  expect(recommendationButtonBox!.y + recommendationButtonBox!.height).toBeLessThanOrEqual(700);
  expect(recommendationCalls).toBe(0);
  await drawer.getByRole("button", { name: "Ver recomendação de compra" }).click();
  await expect(drawer.getByText("Comprar com Fornecedor cotado")).toBeVisible();
  await expect(drawer).toContainText("Fornecedor R$ 5,00 (1,9%) acima do comparador confiável.");
  await expect(drawer).toContainText("Fornecedor dentro do limite de custo definido.");
  await expect(drawer).toContainText("Limite da política: até 5% acima para fornecedor confirmado com prazo igual ou menor.");
  await expect(drawer.getByText("R$ 265,00", { exact: true })).toBeVisible();
  await expect(drawer).toContainText("produtos R$ 250,00 · frete R$ 15,00 · taxas R$ 0,00 · prazo 4 dias · estoque 10");
  await expect(drawer).toContainText("Loja mais confiável");
  await expect(drawer.locator("details[open]")).toHaveCount(0);
  const offerRows = await drawer.getByLabel("Ofertas comparadas").boundingBox();
  expect(offerRows).not.toBeNull();
  expect(offerRows!.y + offerRows!.height).toBeLessThanOrEqual(700);
  await drawer.screenshot({ path: "/tmp/jev-recomendacao-simples.png" });
  await drawer.getByText("Detalhes da análise").click();
  await expect(drawer).toContainText("evidência 33%");
  await drawer.getByText("Detalhes da análise").click();
  await drawer.getByRole("button", { name: "Aceitar recomendação" }).click();
  expect(approvalBody).toEqual({ review_id: "review-jev-1", version: 9, approved: true });
  await expect(drawer.getByRole("status")).toContainText("Recomendação aceita e registrada.");
  expect(recommendationCalls).toBe(1);
  await page.reload();
  await page.locator("#kanban article").filter({ hasText: "Teclado de teste" }).locator('button[aria-pressed]').click();
  const restoredDrawer = page.getByRole("dialog", { name: "Teclado de teste" });
  await expect(restoredDrawer.getByRole("status")).toContainText("Recomendação aceita e registrada.");
  await expect(restoredDrawer).toContainText("R$ 265,00");
  expect(recommendationCalls).toBe(1);
});

test("Jev blocks incomplete comparisons and surfaces provider errors", async ({ page }) => {
  const blockedId = "34343434-3434-4434-8434-343434343434";
  const errorId = "45454545-4545-4454-8454-454545454545";
  const makeRow = (id: string, item: string) => ({
    id, version: 3, item, qty: 2, delivery_location: "São Paulo", status: "DONE", stage: "concluida", mode: "live",
    sources: [], reputations: [], reputation_indications: [], candidates: [], errors: [], blocked_sites: 0, selected_product_url: null,
    quote: { id: `${id}-quote`, supplier_name: "Fornecedor confirmado", product_name: item, final_price: "25.00", shipping_fee: null, final_tco: null, delivery_time: "Não confirmado", conditions: "" },
    purchase_simulation: null, audit: null,
  });
  const blockedRow: any = makeRow(blockedId, "Comparação pendente");
  const errorRow: any = makeRow(errorId, "Falha de Jev");
  await page.route("**/api/auth/me", route => route.fulfill({ json: { user: { id: "u-1", name: "Teste", email: "teste@nexo.local", created_at: "2026-11-08T00:00:00.000Z" } } }));
  await page.route("**/api/godmode/dashboard", route => route.fulfill({ json: { data_mode: "real", total_runs: 2, runs: [blockedRow, errorRow], metrics: { hard_savings: null, cost_avoidance: null, final_spend: null, completed_count: 2, active_count: 0, verified_suppliers_count: 0, pending_tco_count: 2 } } }));
  await page.route(`**/api/request/${blockedId}/purchase-recommendation`, route => route.fulfill({ json: {
    review_id: "blocked-review", version: 3, offer_hash: "hash", recommendation: "review", reason: "no_reliable_comparable_market_offer", explanation: "Nenhum comparador confiável foi encontrado.",
    actual_supplier_tco_cents: null, best_market_offer_id: null, best_market_tco_cents: null,
    most_reliable_market_offer_id: null, most_reliable_market_tco_cents: null, comparator_market_offer_id: null, comparator_market_tco_cents: null, supplier_offer_id: null,
    selected_offer_id: null, threshold_market_tco_cents: null, comparison_basis: "product_subtotal", comparison_supplier_cents: null, comparator_market_cents: null,
    pending_checks: ["shipping", "fees", "availability", "lead_time"], candidates: [],
  } }));
  await page.route(`**/api/request/${errorId}/purchase-recommendation`, route => route.fulfill({ status: 503, json: { detail: "Jev indisponível no momento; nenhuma recomendação foi salva." } }));
  await page.goto("/dashboard");
  const blockedCard = page.locator("#kanban article").filter({ hasText: "Comparação pendente" }).locator('button[aria-pressed]');
  await blockedCard.click();
  const blockedDrawer = page.getByRole("dialog", { name: "Comparação pendente" });
  await blockedDrawer.getByRole("button", { name: "Ver recomendação de compra" }).click();
  await expect(blockedDrawer.getByText("Faltam dados para recomendar")).toBeVisible();
  await expect(blockedDrawer).toContainText("frete, taxas adicionais, estoque disponível, prazo de entrega");
  await expect(blockedDrawer.getByRole("status")).toContainText("Análise bloqueada");
  await expect(blockedDrawer.getByRole("button", { name: "Aceitar recomendação" })).toHaveCount(0);
  await blockedDrawer.getByRole("button", { name: "Fechar detalhes" }).click();
  await page.locator("#kanban article").filter({ hasText: "Falha de Jev" }).locator('button[aria-pressed]').click();
  const errorDrawer = page.getByRole("dialog", { name: "Falha de Jev" });
  await errorDrawer.getByRole("button", { name: "Ver recomendação de compra" }).click();
  await expect(errorDrawer.getByRole("alert")).toContainText("Jev indisponível no momento");
  await expect(errorDrawer.getByRole("button", { name: "Ver recomendação de compra" })).toBeVisible();
});

test("Jev records a user's rejection through the approval endpoint", async ({ page }) => {
  const id = "56565656-5656-4565-8565-565656565656";
  const row: any = {
    id, version: 4, item: "Cabo de rede", qty: 1, delivery_location: "São Paulo", status: "DONE", stage: "concluida", mode: "live",
    sources: [], reputations: [], reputation_indications: [], candidates: [], errors: [], blocked_sites: 0, selected_product_url: null,
    quote: { id: "67676767-6767-4676-8676-676767676767", supplier_name: "Fornecedor cotado", product_name: "Cabo de rede", final_price: "20.00", shipping_fee: "5.00", final_tco: "25.00", delivery_time: "2 dias", conditions: "" },
    purchase_simulation: null, audit: { final_tco: "25.00", additional_cost_total: "0.00" },
  };
  await page.route("**/api/auth/me", route => route.fulfill({ json: { user: { id: "u-1", name: "Teste", email: "teste@nexo.local", created_at: "2026-11-08T00:00:00.000Z" } } }));
  await page.route("**/api/godmode/dashboard", route => route.fulfill({ json: { data_mode: "real", total_runs: 1, runs: [row], metrics: { hard_savings: "0", cost_avoidance: "0", final_spend: "25.00", completed_count: 1, active_count: 0, verified_suppliers_count: 0, pending_tco_count: 0 } } }));
  const payload = {
    review_id: "reject-review", version: 4, offer_hash: "reject-hash", recommendation: "supplier", verdict: "Fornecedor dentro do limite de custo definido.", reason: "supplier_at_or_below_reliable_market", policy_version: "supplier-premium-v1", supplier_max_premium_percent: 5, supplier_premium_allowed: false, premium_limit_cents: 2600, savings_or_premium_cents: -100, savings_or_premium_percent: -3.85, comparison_provisional: false,
    actual_supplier_tco_cents: 2500, actual_supplier_comparison_cents: 2500,
    comparator_market_offer_id: "reject-market", comparator_market_cents: 2600, comparison_basis: "complete_tco", comparison_supplier_cents: 2500, pending_checks: [],
    supplier_offer_id: "reject-supplier", selected_offer_id: "reject-supplier", candidates: [
      { offer_id: "reject-supplier", supplier: "Fornecedor cotado", channel: "telegram", tco_cents: 2500, product_subtotal_cents: 2000, shipping_cents: 500, fees_cents: 0, lead_days: 2, available_qty: 3, reliable: true, comparable: true, is_completed_supplier: true, pending_checks: [] },
      { offer_id: "reject-market", supplier: "Loja confiável", channel: "market", tco_cents: 2600, product_subtotal_cents: 2600, shipping_cents: 0, fees_cents: 0, lead_days: 2, available_qty: 5, reliable: true, comparable: true, pending_checks: [] },
    ],
  };
  await page.route(`**/api/request/${id}/purchase-recommendation`, route => route.fulfill({ json: payload }));
  let answer: any;
  await page.route(`**/api/request/${id}/purchase-recommendation/approval`, async route => { answer = route.request().postDataJSON(); await route.fulfill({ json: { review_id: "reject-review", approved: false, selected_offer_id: "reject-supplier", version: 4 } }); });
  await page.goto("/dashboard");
  await page.locator("#kanban article").filter({ hasText: "Cabo de rede" }).locator('button[aria-pressed]').click();
  const drawer = page.getByRole("dialog", { name: "Cabo de rede" });
  await drawer.getByRole("button", { name: "Ver recomendação de compra" }).click();
  await drawer.getByRole("button", { name: "Recusar" }).click();
  expect(answer).toEqual({ review_id: "reject-review", version: 4, approved: false });
  await expect(drawer.getByRole("status")).toContainText("Recomendação recusada e registrada.");
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
  await page.route("**/api/auth/me", route => route.fulfill({ json: { user: { id: "u-1", name: "Teste", email: "teste@nexo.local", created_at: "2026-11-07T00:00:00.000Z" } } }));
  await page.route("**/api/godmode/dashboard", route => route.fulfill({ json: { data_mode: "real", total_runs: 2, runs: [negotiatingRow, doneRow], metrics: { hard_savings: "0", cost_avoidance: "0", final_spend: "2457.00", completed_count: 1, active_count: 1, verified_suppliers_count: 2, pending_tco_count: 0 } } }));
  let marketPayloads: any[] = [];
  await page.route(`**/api/request/${doneId}/market-preference`, async route => {
    const body = route.request().postDataJSON();
    marketPayloads.push(body);
    doneRow.preferred_market_quote_id = body.quote_id;
    doneRow.version += 1;
    await route.fulfill({ status: 201, json: doneRow });
  });
  await page.goto("/dashboard");
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

test("dashboard keeps partial WhatsApp quote visible in its own channel and out of web sources", async ({ page }) => {
  const id = "77777777-7777-4777-8777-777777777777";
  const row: any = {
    id, version: 1, item: "Monitor Dell 24", qty: 2, delivery_location: "13565090", status: "NEGOTIATING", stage: "comparação",
    quote_completion_state: "coletando", missing_fields: ["fees_cents", "destination_confirmed"], mode: "live",
    reputations: [], reputation_indications: [], candidates: [], errors: [], blocked_sites: 0,
    sources: [], selected_product_url: null, market_average: null,
    quote: { id: "wa-quote-1", channel: "whatsapp", supplier_id: "whatsapp:loja-a", supplier_name: "Loja WhatsApp A", product_name: "Monitor Dell 24", product_url: "", initial_price: "90.00", final_price: "90.00", shipping_fee: "12.00", fees_fee: null, final_tco: null, event_id: "whatsapp:event-1", conditions: "", delivery_time: "Não confirmado", available_qty: null },
    whatsapp_pending: [{ supplier_id: "whatsapp:loja-a", supplier_name: "Loja WhatsApp A", number: "5511999999999", terms: { unit_cents: 9000, shipping_cents: 1200, fees_cents: null }, missing_fields: ["fees_cents", "lead_days", "available_qty", "product_confirmed", "destination_confirmed"], updated_at: "2026-11-08T10:00:00.000Z" }],
    purchase_simulation: null, preferred_market_quote_id: null, audit: null,
  };
  await page.route("**/api/auth/me", route => route.fulfill({ json: { user: { id: "u-1", name: "Teste", email: "teste@nexo.local", created_at: "2026-11-08T00:00:00.000Z" } } }));
  await page.route("**/api/godmode/dashboard", route => route.fulfill({ json: { data_mode: "real", total_runs: 1, runs: [row], metrics: { hard_savings: null, cost_avoidance: null, final_spend: null, completed_count: 0, active_count: 1, verified_suppliers_count: 0, pending_tco_count: 0 } } }));
  await page.goto("/dashboard");
  const card = page.locator("#kanban article").filter({ hasText: "Monitor Dell 24" });
  await expect(card).toContainText("WhatsApp · 1 fornecedor");
  await expect(card).toContainText("R$ 90,00");
  await card.locator('button[aria-pressed]').click();
  const drawer = page.getByRole("dialog", { name: "Monitor Dell 24" });
  const whatsapp = drawer.getByRole("region", { name: "Propostas recebidas pelo WhatsApp" });
  await expect(whatsapp).toContainText("Loja WhatsApp A");
  await expect(whatsapp).toContainText("R$ 90,00 × 2");
  await expect(whatsapp).toContainText("R$ 12,00");
  await expect(whatsapp).toContainText("Não informado");
  await expect(drawer.getByRole("region", { name: "Opções do mercado" })).toContainText("0 ofertas na internet");
  await expect(drawer.locator('a[href^="http"]')).toHaveCount(0);
});

test("price history with sparse observations stays unknown and plots only real records", async ({ page }) => {
  const id = "88888888-8888-4888-8888-888888888888";
  const row: any = { id, version: 1, item: "Mouse Logitech G Pro", qty: 1, delivery_location: "13565090", status: "NEGOTIATING", stage: "comparação", mode: "live", sources: [], reputations: [], reputation_indications: [], candidates: [], errors: [], blocked_sites: 0, selected_product_url: null, quote: null, purchase_simulation: null, audit: null };
  await page.route("**/api/auth/me", route => route.fulfill({ json: { user: { id: "u-1", name: "Teste", email: "teste@nexo.local", created_at: "2026-11-08T00:00:00.000Z" } } }));
  await page.route("**/api/godmode/dashboard", route => route.fulfill({ json: { data_mode: "real", total_runs: 1, runs: [row], metrics: { hard_savings: null, cost_avoidance: null, final_spend: null, completed_count: 0, active_count: 1, verified_suppliers_count: 0, pending_tco_count: 0 } } }));
  await page.route(`**/api/procurement/${id}/price-history?days=60`, route => route.fulfill({ json: {
    history: [{ date: "2026-11-08", price: "90.00", supplier: "Loja A" }], observed_history: [{ date: "2026-11-08", price: "90.00", supplier: "Loja A" }],
    analysis: null, historical_average: null, selected_price: "90.00", selected_date: "2026-11-08", price_source: "reference", data_source: "unavailable", analysis_source: "insufficient_data", days: 60, real_observation_count: 1,
    message: "Há 1 dia com preço observado no período; são necessárias ao menos 7 datas distribuídas por 7 dias. O histórico, a média e o momento de compra permanecem desconhecidos até haver observações suficientes.",
  } }));
  await page.goto("/dashboard/analise-economica");
  const section = page.getByRole("region", { name: "Histórico Temporal de Preços & Timing de Compra" });
  await expect(section).toBeVisible();
  await expect(section).toContainText("Histórico real insuficiente");
  await expect(section).toContainText("média histórica, a tendência e a recomendação permanecem desconhecidas");
  await section.getByText("Consultar registros reais (1)").click();
  await expect(section.getByRole("row")).toHaveCount(2);
  await expect(section).toContainText("Loja A");
  await expect(section).not.toContainText("Momento Ideal para Compra");
});

test("starts with real data and the purchase pipeline", async ({ page }) => {
  await page.goto("/dashboard");
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
  await expect(page.locator("#kanban")).toBeVisible();
  await page.getByRole("button", { name: "Nova solicitação", exact: true }).click();
  await expect(page.getByLabel("Nome do item")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).not.toBeVisible();
});

test("submits a real discovery and shows evidence or an explicit collection failure", async ({ page }) => {
  test.setTimeout(90000);
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto("/dashboard");
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
  await page.goto("/dashboard");
  await expect(page.getByText("API conectada", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: "test-results/real-dashboard-mobile.png", fullPage: true });
  await page.route("**/api/auth/me", route => route.fulfill({ json: { user: { id: "u-1", name: "Teste", email: "teste@nexo.local", created_at: "2026-11-07T00:00:00.000Z" } } }));
  await page.route("**/api/godmode/dashboard", route => route.abort());
  await page.getByRole("button", { name: "Atualizar dados" }).click();
  await expect(page.getByText("Sem conexão", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Nova solicitação", exact: true })).toBeDisabled();
  await expect(page.getByText("Demonstração local", { exact: true })).toHaveCount(0);
});

test("sandbox observer renders both roles, polls, and stops when closed", async ({ page }) => {
  await page.goto("/dashboard");
  await expect(page.getByText("API conectada", { exact: true })).toBeVisible();
  const created = await page.request.post("/api/request", { data: { item: "Mouse Logitech M170", mode: "sandbox", qty: 1, delivery_location: "CEP 01001-000, SP" } });
  expect(created.ok()).toBe(true);
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
  await page.route("**/api/auth/me", route => route.fulfill({ json: { user: { id: "u-1", name: "Teste", email: "teste@nexo.local", created_at: "2026-11-07T00:00:00.000Z" } } }));
  await page.route("**/api/godmode/dashboard", route => route.fulfill({ json: { data_mode: "real", total_runs: 1, runs: [row], metrics: { hard_savings: "60.00", cost_avoidance: "40.00", final_spend: "165.00", completed_count: 1, active_count: 0, verified_suppliers_count: 1, pending_tco_count: 0 } } }));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/dashboard");
  await page.locator("#kanban").getByRole("button", { name: /Produto do teste de interface/ }).click();
  const drawer = page.getByRole("dialog", { name: "Produto do teste de interface" });
  await expect(drawer.getByRole("region", { name: "Composição do TCO" }).getByText("R$ 165,00", { exact: true })).toBeVisible();
  await expect(drawer.getByText("Cotação auditada com frete e quantidade confirmados.")).toBeVisible();
  await expect(drawer.getByRole("link", { name: "Produto na loja" })).toHaveAttribute("href", source.product_url);
  expect(Math.round((await drawer.boundingBox())!.width)).toBeLessThanOrEqual(390);
  await page.keyboard.press("Escape");
  await expect(drawer).not.toBeVisible();
});
