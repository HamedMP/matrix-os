import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { shellRequire } from "./shell-require.mjs";
const { chromium } = shellRequire("@playwright/test");

const repository = resolve(import.meta.dirname, "../../..");
const catalog = JSON.parse(await readFile(join(repository, "home/system/app-gallery.json"), "utf8"));
const browser = await chromium.launch({
  headless: true,
  ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}),
});
try {
  for (const viewport of [{ width: 390, height: 844 }, { width: 1280, height: 900 }]) {
    const page = await browser.newPage({ viewport, colorScheme: "dark" });
    for (const { id } of catalog.apps) {
      await page.goto(`${process.env.PREVIEW_BASE_URL ?? "http://127.0.0.1:3052"}/?app=${encodeURIComponent(id)}`, { waitUntil: "networkidle" });
      await page.locator(`.workbench[data-app="${id}"]`).waitFor({ state: "visible" });
      const layout = await page.evaluate(() => ({
        pageWidth: document.documentElement.scrollWidth,
        viewportWidth: innerWidth,
        background: getComputedStyle(document.querySelector(".workbench")).backgroundColor,
        cardBackground: getComputedStyle(document.querySelector(".workflow-panel, .ledger, .subscriptions-welcome") ?? document.querySelector("main")).backgroundColor,
      }));
      if (layout.pageWidth > layout.viewportWidth) throw new Error(`${id} overflows at ${viewport.width}px: ${layout.pageWidth}px`);
      if (layout.background === "rgb(0, 0, 0)" || layout.cardBackground === "rgb(0, 0, 0)") throw new Error(`${id} unexpectedly rendered black in dark host mode`);
    }
    await page.close();
    process.stdout.write(`Verified ${catalog.apps.length} apps at ${viewport.width}px\n`);
  }
} finally {
  await browser.close();
}
