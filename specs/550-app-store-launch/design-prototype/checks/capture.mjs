import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const output = resolve(process.argv[2] ?? '../evidence');
const origin = process.env.PREVIEW_ORIGIN ?? 'http://127.0.0.1:3036';
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  for (const width of [1440, 390]) {
    const context = await browser.newContext({ viewport: { width, height: width === 1440 ? 1100 : 900 }, deviceScaleFactor: 1 });
    try {
      const page = await context.newPage();
      await page.goto(origin, { waitUntil: 'networkidle', timeout: 20000 });
      await page.evaluate(async () => { await document.fonts.ready; await Promise.all([...document.images].map(image => image.decode().catch(() => null))); });
      await page.screenshot({ path: `${output}/storefront-${width === 1440 ? 'desktop' : 'phone'}.png` });
      if (width === 390) {
        await page.getByRole('button', { name: 'Try onboarding', exact: true }).click();
        await page.locator('.connect-choices button').filter({ hasText: 'Gmail' }).click();
        await page.getByRole('button', { name: 'Continue', exact: true }).click();
        await page.getByRole('button', { name: 'Try the example connection' }).click();
        await page.locator('.example-account select').nth(1).selectOption('Work');
        await page.screenshot({ path: `${output}/onboarding-accounts.png` });
      }
    } finally { await context.close(); }
  }
  process.stdout.write(`Captured three actual design screenshots in ${output}\n`);
} finally { await browser.close(); }
