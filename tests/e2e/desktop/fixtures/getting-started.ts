import type { Page } from "playwright";

/** Dismiss the real checklist through Help before it blocks unrelated E2E actions. */
export async function dismissGettingStartedOnInteraction(page: Page): Promise<void> {
  await page.addLocatorHandler(page.getByRole("dialog", { name: "Getting started", exact: true }), async () => {
    const checklist = page.getByRole("button", { name: /^Getting started —/ });
    const help = page.getByRole("button", { name: "Help", exact: true });
    if (!await checklist.isVisible()) await help.click();
    await checklist.click();
    if (await help.getAttribute("aria-expanded") === "true") await help.click();
  });
}
