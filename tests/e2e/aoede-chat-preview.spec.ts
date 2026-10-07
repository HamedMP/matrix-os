import { expect, test } from "@playwright/test";

test("narrow Chat preview keeps starters and composer usable across resizing", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/?chat-preview=1&surface=web_canvas");
  const preview = page.locator(".matrix-chat-presentation");
  const conversation = preview.locator("main");
  await expect(conversation).toBeVisible();
  expect((await conversation.boundingBox())!.width).toBeGreaterThan(300);
  const cards = preview.locator('[data-slot="chat-starter-cards"] button');
  await expect(cards).toHaveCount(4);
  const bounds = (await preview.boundingBox())!;
  for (const card of await cards.all()) {
    const box = (await card.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(bounds.x);
    expect(box.x + box.width).toBeLessThanOrEqual(bounds.x + bounds.width);
    expect(box.y).toBeGreaterThanOrEqual(bounds.y);
    expect(box.y + box.height).toBeLessThanOrEqual(bounds.y + bounds.height);
  }
  await cards.first().click();
  await expect(page.getByRole("textbox", { name: "Fixture chat draft" })).toHaveValue("Explore and understand code");
  expect((await preview.locator("[data-chat-composer]").boundingBox())!.width).toBeGreaterThan(260);

  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(preview.locator("aside")).toBeVisible();
  await preview.getByRole("tab", { name: "Voice conversations" }).click();
  await preview.getByRole("button", { name: /Plan the launch week/ }).click();
  await expect(preview.locator('[data-chat-message="assistant"]')).toHaveText("Which day should we start with?");
  await page.setViewportSize({ width: 375, height: 812 });
  await expect(preview.locator("aside")).toBeHidden();
  await expect(preview.locator('[data-chat-message="assistant"]')).toBeVisible();
});
