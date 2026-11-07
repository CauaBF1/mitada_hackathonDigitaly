import { expect, test } from "@playwright/test";

test("streams an auction, persists the evidence and resumes SSE through the proxy", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto("/");
  await expect(page.getByText("API conectada", { exact: true })).toBeVisible();
  await expect(page.getByText("Ao vivo", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Nova cotação", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Nova cotação inteligente" });
  await dialog.getByLabel("O que você precisa comprar?").fill("Monitores do leilão de teste");
  await dialog.getByLabel("Referência unitária (R$)").fill("100,00");
  await dialog.getByLabel("Quantidade", { exact: true }).fill("3");
  await dialog.getByRole("button", { name: "Iniciar cotação simulada" }).click();
  await expect(dialog).not.toBeVisible();
  const terminal = page.getByRole("log", { name: "Eventos do agente" });
  await expect(terminal.getByText(/Consultando referências de mercado simuladas/)).toBeVisible();
  await expect(terminal.getByText(/Cotação simulada concluída/)).toBeVisible();
  await expect(page.getByText("Concluída", { exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Indicadores de economia" }).getByText("R$ 21,45", { exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Indicadores de economia" }).getByText("R$ 14,25", { exact: true })).toBeVisible();
  await expect(page.getByText("Rejeitado", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const runId = Number(await page.getByLabel("Selecionar cotação").inputValue());
  const history = await (await page.request.get(`/api/godmode/events/history?run_id=${runId}`)).json();
  const lastId = history.at(-1).id as number;
  const frame = await page.evaluate(async ({ runId, lastId }) => {
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), 10000);
    try {
      const response = await fetch(`/api/godmode/events?run_id=${runId}`, { headers: { "Last-Event-ID": String(lastId - 1) }, signal: abort.signal });
      if (!response.headers.get("content-type")?.includes("text/event-stream")) throw new Error("Expected an event stream");
      const reader = response.body!.getReader();
      let result = "";
      while (!result.includes("event: log")) {
        const { value, done } = await reader.read();
        if (done) throw new Error("Stream ended before event");
        result += new TextDecoder().decode(value);
      }
      await reader.cancel();
      return result;
    } finally { clearTimeout(timeout); abort.abort(); }
  }, { runId, lastId });
  expect(frame).toContain(`id: ${lastId}\n`);
  expect(frame).toContain("Cotação simulada concluída");
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Exportar" }).click();
  expect((await download).suggestedFilename()).toMatch(/^nexo-cotacao-\d+\.json$/);
  await page.reload();
  await expect(page.getByText("Concluída", { exact: true })).toBeVisible();
  await expect(terminal.getByText(/Cotação simulada concluída/)).toHaveCount(1);
  await page.screenshot({ path: "test-results/godmode-desktop.png", fullPage: true });
  expect(errors).toEqual([]);
});

test("mobile layout and offline state remain usable without fabricated data", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(page.getByText("API conectada", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole("button", { name: "Nova cotação", exact: true }).click();
  await expect(page.getByLabel("O que você precisa comprar?")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await page.screenshot({ path: "test-results/godmode-mobile.png", fullPage: true });
  await page.route("**/api/godmode/dashboard", route => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ detail: "Conexão interrompida" }) }));
  await page.getByRole("button", { name: "Atualizar dados" }).click();
  await expect(page.getByText("Sem conexão", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Nova cotação", exact: true })).toBeDisabled();
  await expect(page.getByText("Concluída", { exact: true })).toBeVisible();
});
