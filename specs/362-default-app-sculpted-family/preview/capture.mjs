import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { shellRequire } from "./shell-require.mjs";
const { chromium } = shellRequire("@playwright/test");

const repository = resolve(import.meta.dirname, "../../..");
const catalog = JSON.parse(await readFile(join(repository, "home/system/app-gallery.json"), "utf8"));
const requested = process.argv.slice(2);
const apps = requested.length ? catalog.apps.filter(({ id }) => requested.includes(id)) : catalog.apps;
if (apps.length !== (requested.length || catalog.apps.length)) throw new Error("Unknown Gallery app ID");
const browser = await chromium.launch({
  headless: true,
  ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}),
});
try {
  const page = await browser.newPage({ viewport: { width: 1738, height: 2033 }, deviceScaleFactor: 1, colorScheme: "light", locale: "en-US", timezoneId: "UTC" });
  for (const { id } of apps) {
    await page.goto(`http://127.0.0.1:3052/?app=${encodeURIComponent(id)}`, { waitUntil: "networkidle" });
    await page.locator(`.workbench[data-app="${id}"]`).waitFor({ state: "visible" });
    await page.evaluate(async () => {
      await document.fonts.ready;
      await Promise.all([...document.images].map(image => image.decode()));
    });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    if (overflow) throw new Error(`${id} has horizontal overflow`);
    await page.screenshot({ path: join(repository, "home/apps/app-gallery/src/assets/previews", `${id}.png`), fullPage: false });
    process.stdout.write(`Captured ${id}\n`);
  }
} finally {
  await browser.close();
}
