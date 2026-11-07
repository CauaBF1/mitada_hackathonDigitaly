import { expect, test } from "@playwright/test";

test("creates a purchase through the API and polls its finalized quote", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/classic");
  await expect(page.getByText("API conectada", { exact: true })).toBeVisible();
  await expect(page.getByText("R$ 10.550,00", { exact: true })).toBeVisible();
  await page.screenshot({ path: "test-results/dashboard-desktop.png", fullPage: true });
  await page.getByRole("button", { name: "Nova solicitação", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Nova solicitação" });
  await dialog.getByLabel("O que você precisa comprar?").fill("Impressoras para o escritório");
  await dialog.getByLabel("Preço-alvo unitário (R$)").fill("100,00");
  await dialog.getByLabel("Quantidade", { exact: true }).fill("3");
  await dialog.getByRole("button", { name: "Iniciar negociação" }).click();
  await expect(dialog).not.toBeVisible();
  const completed = page.getByRole("region", { name: "Concluídas", exact: true });
  await expect(completed.getByRole("heading", { name: "Impressoras para o escritório" })).toBeVisible();
  const card = completed.locator("article").filter({ hasText: "Impressoras para o escritório" });
  await expect(card.getByText("R$ 60,00", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Ver detalhes de Impressoras para o escritório" }).click();
  await expect(page.getByRole("dialog", { name: "Detalhes da solicitação" }).getByText("(R$ 120,00 − R$ 100,00) × 3 = R$ 60,00")).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByRole("textbox", { name: "Buscar solicitações" }).fill("Impressoras para o escritório");
  await expect(page.locator("article")).toHaveCount(1);
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Exportar" }).click();
  expect((await download).suggestedFilename()).toBe("nexo-economias.csv");
  expect(errors).toEqual([]);
});

test("local fallback is explicit, creates locally, progresses and survives reload", async ({ page }) => {
  let writes = 0;
  await page.route("**/api/**", async (route) => {
    if (route.request().method() === "POST") writes++;
    await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ detail: "API indisponível" }) });
  });
  await page.goto("/classic");
  await expect(page.getByText("Demonstração local", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Nova solicitação", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Nova solicitação" });
  await dialog.getByLabel("O que você precisa comprar?").fill("Compra local isolada");
  await dialog.getByLabel("Preço-alvo unitário (R$)").fill("50");
  await dialog.getByLabel("Quantidade", { exact: true }).fill("2");
  await dialog.getByRole("button", { name: "Iniciar negociação" }).click();
  await expect(page.getByRole("region", { name: "Na fila", exact: true }).getByRole("heading", { name: "Compra local isolada" })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: "Compra local isolada" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Concluídas", exact: true }).getByRole("heading", { name: "Compra local isolada" })).toBeVisible({ timeout: 25000 });
  expect(writes).toBe(0);
});

test("failed API creation remains an error and never becomes a local purchase", async ({ page }) => {
  await page.goto("/classic");
  await expect(page.getByText("API conectada", { exact: true })).toBeVisible();
  await page.route("**/api/request", (route) => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ detail: "Falha de gravação de teste" }) }));
  await page.getByRole("button", { name: "Nova solicitação", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Nova solicitação" });
  await dialog.getByLabel("O que você precisa comprar?").fill("Não pode ser criada localmente");
  await dialog.getByLabel("Preço-alvo unitário (R$)").fill("100");
  await dialog.getByRole("button", { name: "Iniciar negociação" }).click();
  await expect(dialog.getByRole("alert")).toHaveText("Falha de gravação de teste");
  await expect(page.getByText("API conectada", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Não pode ser criada localmente" })).toHaveCount(0);
});

test("mobile layout fits and the form supports keyboard dismissal", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/classic");
  await expect(page.getByText("API conectada", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: "test-results/dashboard-mobile.png", fullPage: true });
  await page.getByRole("button", { name: "Nova solicitação", exact: true }).click();
  await expect(page.getByLabel("O que você precisa comprar?")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Nova solicitação" })).not.toBeVisible();
});

test("a lost connection preserves API data and disables creation", async ({ page }) => {
  await page.goto("/classic");
  await expect(page.getByText("API conectada", { exact: true })).toBeVisible();
  const count = await page.locator("article").count();
  await page.route("**/api/**", (route) => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ detail: "Conexão interrompida" }) }));
  await page.getByRole("button", { name: "Atualizar dados" }).click();
  await expect(page.getByText("Sem conexão", { exact: true })).toBeVisible();
  await expect(page.locator("article")).toHaveCount(count);
  await expect(page.getByRole("button", { name: "Nova solicitação", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Adicionar solicitação à fila" })).toBeDisabled();
  await expect(page.getByText("Demonstração local", { exact: true })).toHaveCount(0);
});
