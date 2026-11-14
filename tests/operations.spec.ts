import { expect, test, type APIRequestContext } from "@playwright/test";

type TestPublication = { id: string; title: string; version: number };

async function publicationFixture(request: APIRequestContext, data: { title: string; description?: string }) {
  const response = await request.post("/api/publications", { data });
  expect(response.ok(), await response.text()).toBeTruthy();
  return await response.json() as TestPublication;
}

async function removeFixture(request: APIRequestContext, publication: TestPublication) {
  const endpoint = `/api/publications/${publication.id}`;
  const record = await request.get(endpoint);
  if (record.ok()) {
    const { version } = await record.json();
    await request.delete(endpoint, { data: { version } });
  }
  await request.delete(`/api/trash/publication/${publication.id}`, { data: { confirm: true } });
}

test("calendar schedules and moves a publication in the studio timezone", async ({ page, request }) => {
  const publication = await publicationFixture(request, { title: "Календарный выпуск Playwright" });
  try {
    await page.goto("/calendar");
    await expect(page.getByRole("heading", { name: "Календарь", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Запланировать" }).click();
    const modal = page.getByRole("dialog");
    await modal.getByRole("searchbox", { name: "Поиск публикации" }).fill(publication.title);
    await modal.getByRole("combobox").selectOption(publication.id, { timeout: 10000 });
    const localDateInput = modal.locator("input[type=datetime-local]");
    const today = (await localDateInput.inputValue()).slice(0, 10);
    await localDateInput.fill(`${today}T15:20`);
    await modal.getByRole("button", { name: "Сохранить" }).click();
    await expect(modal).toBeHidden();
    const row = page.locator(".ops-row").filter({ hasText: publication.title });
    await expect(row).toBeVisible();
    await row.getByRole("button", { name: "Перенести", exact: true }).click();
    await localDateInput.fill(`${today}T18:10`);
    await modal.getByRole("button", { name: "Сохранить" }).click();
    await expect(modal).toBeHidden();

    const current = await (await request.get(`/api/publications/${publication.id}`)).json();
    expect(current.status_id).toBe("scheduled");
    expect(current.scheduled_at).toBe(`${today}T15:10:00.000Z`);
    await page.getByRole("button", { name: "Список", exact: true }).click();
    await expect(page.getByRole("link", { name: publication.title })).toBeVisible();
  } finally {
    await removeFixture(request, publication).catch(() => {});
  }
});

test("system performs a live D1 and R2 diagnosis", async ({ page }) => {
  await page.goto("/system");
  await page.getByRole("button", { name: "Запустить диагностику" }).click();
  const diagnosis = page.locator("section").filter({ has: page.getByRole("heading", { name: "Результат диагностики" }) });
  await expect(diagnosis.getByText("Доступна", { exact: true })).toHaveCount(2);
});

test("a publication in the trash can be restored with versioned data", async ({ page, request }) => {
  const publication = await publicationFixture(request, { title: "Выпуск для восстановления Playwright", description: "Описание исходного выпуска" });
  try {
    const removed = await request.delete(`/api/publications/${publication.id}`, { data: { version: publication.version } });
    expect(removed.ok(), await removed.text()).toBeTruthy();

    await page.goto("/trash");
    const row = page.locator(".ops-row").filter({ hasText: publication.title });
    await expect(row).toBeVisible();
    await row.getByRole("button", { name: "Восстановить", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "Объект восстановлен." })).toBeVisible();
    const onceMore = await (await request.get(`/api/publications/${publication.id}`)).json();
    expect(onceMore.description).toBe("Описание исходного выпуска");
    expect(onceMore.version).toBeGreaterThan(publication.version);
  } finally {
    await removeFixture(request, publication).catch(() => {});
  }
});

test("operational pages fit a narrow phone", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 820 });
  for (const [path, title] of [["calendar", "Календарь"], ["archive", "Архив"], ["trash", "Корзина"], ["settings", "Настройки"], ["system", "Система"], ["backup", "Резервные копии"]]) {
    await page.goto(`/${path}`);
    await expect(page.getByRole("heading", { level: 1, name: title, exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth), path).toBeLessThanOrEqual(320);
  }
});

test("browser downloads a portable studio ZIP", async ({ page }) => {
  await page.goto("/backup");
  const archive = page.waitForEvent("download");
  await page.getByRole("button", { name: "Скачать ZIP" }).click();
  const download = await archive;
  expect(download.suggestedFilename()).toMatch(/^remake-ai-studio-\d{4}-\d{2}-\d{2}\.zip$/);
  const stream = await download.createReadStream();
  for await (const chunk of stream) {
    expect(chunk.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    break;
  }
  await expect(page.getByText("Резервная копия подготовлена.", { exact: false })).toBeVisible();
});
