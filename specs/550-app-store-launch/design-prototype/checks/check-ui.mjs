import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const origin = process.env.PREVIEW_ORIGIN ?? 'http://127.0.0.1:3036';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const results = [];
try {
  for (const width of [360, 390, 600, 820, 1024, 1440]) {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, deviceScaleFactor: 1 });
    try {
      const page = await context.newPage();
      const errors = [];
      const privilegedRequests = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('request', request => { if (new URL(request.url()).pathname.startsWith('/api/')) privilegedRequests.push(request.url()); });
      await page.goto(origin, { waitUntil: 'networkidle', timeout: 20000 });
      await page.evaluate(() => document.fonts.ready);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width, `page overflow at ${width}`);
      assert.equal(await page.locator('.store-listing').count(), 8);
      assert.equal(await page.locator('.feature-screenshot').first().evaluate(element => element.getBoundingClientRect().top < 650), true, 'real apps must appear early');
      await page.getByRole('searchbox', { name: 'Search apps' }).fill('no-such-app');
      await page.getByRole('heading', { name: 'No apps found.' }).waitFor();
      await page.getByRole('button', { name: 'Clear search' }).click();
      await page.getByRole('button', { name: 'Try onboarding', exact: true }).click();
      await page.locator('.connect-choices button').filter({ hasText: 'Gmail' }).click();
      await page.locator('.connect-choices button').filter({ hasText: 'Google Calendar' }).click();
      await page.getByRole('button', { name: 'Continue', exact: true }).click();
      await page.getByRole('button', { name: 'Try the example connection' }).click();
      await page.getByRole('heading', { name: 'Make these accounts yours.' }).waitFor({ timeout: 3000 });
      assert.equal(await page.locator('.example-account').count(), 3, 'two example Gmail accounts and one Calendar identity');
      await page.locator('.example-account select').first().selectOption('Work');
      await page.getByRole('button', { name: 'Save example accounts' }).click();
      await page.getByRole('button', { name: 'See your recommendations' }).click();
      await page.locator('.store-listing').filter({ hasText: 'Revenue' }).click();
      await page.getByRole('button', { name: 'Try phone layout' }).click();
      const before = await page.locator('iframe').getAttribute('src');
      assert.equal(await page.locator('iframe').getAttribute('sandbox'), 'allow-scripts allow-forms');
      await page.getByRole('button', { name: 'Connect your tools', exact: true }).click();
      assert.equal(await page.locator('.connect-choices button').filter({ hasText: 'Gmail' }).isDisabled(), true, 'existing accounts cannot be silently disconnected');
      await page.locator('.connect-choices button').filter({ hasText: 'Stripe' }).click();
      await page.getByRole('button', { name: 'Continue', exact: true }).click();
      await page.getByRole('button', { name: 'Try the example connection' }).click();
      await page.getByRole('button', { name: 'Save example accounts' }).click();
      await page.getByRole('button', { name: 'See your recommendations' }).click();
      assert.equal(await page.locator('iframe').getAttribute('src'), before, 'return to selected app and phone mode');
      assert.equal(await page.locator('dialog').count(), 1);
      await page.getByRole('button', { name: 'Preview install flow' }).click();
      await page.getByRole('heading', { name: 'Review installation' }).waitFor();
      assert.equal(await page.locator('.rating-preview').count(), 0, 'no rating offer before installation confirmation');
      await page.getByRole('button', { name: 'Confirm example installation' }).click();
      await page.getByRole('button', { name: 'Example rating 4 stars' }).click();
      await page.getByText('Your example choice: 4 stars. Nothing is submitted.').waitFor();
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('dialog').count(), 0);
      assert.deepEqual(privilegedRequests, []);
      assert.deepEqual(errors, []);
      results.push({ width, overflow: false, onboarding: 'passed', selectedAppPreserved: true, permissionsBeforeInstall: true, privateRequests: 0, pageErrors: 0 });
    } finally { await context.close(); }
  }
  process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
} finally { await browser.close(); }
