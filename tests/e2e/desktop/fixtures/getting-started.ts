import type { Page } from "playwright";

/** Dismiss the real checklist through its Setup pill before it blocks unrelated E2E actions. */
export async function dismissGettingStartedOnInteraction(page: Page): Promise<void> {
  await page.addLocatorHandler(page.getByRole("dialog", { name: "Getting started", exact: true }), async () => {
    const pill = page.getByRole("button", { name: /^Getting started —/ });
    if (await pill.isVisible()) await pill.click();
  });
}
