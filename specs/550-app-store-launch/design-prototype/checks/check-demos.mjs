import assert from 'node:assert/strict';
import { chromium } from 'playwright';

// Real browser interactions against fictional previews, never owner persistence
// or Native Mobile proof. No screenshots, report files, or provider calls.
const origin = new URL(process.env.PREVIEW_ORIGIN ?? 'http://127.0.0.1:3036').origin;
assert.match(origin, /^https?:\/\//, 'PREVIEW_ORIGIN must be an HTTP(S) origin');
const apps = [
  ['folio', 'Folio'], ['atlas', 'Atlas'], ['agenda', 'Agenda'],
  ['subscriptions', 'Subscriptions'], ['focus', 'Focus'],
  ['meeting-briefs', 'Meeting Briefs'], ['projects', 'Projects'], ['revenue', 'Revenue'],
];
const browser = await chromium.launch({ channel: 'chrome', headless: true });
let context;
let completed = 0;
try {
  context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  page.setDefaultNavigationTimeout(15_000);
  const counts = { errors: 0, externalRequests: 0, posts: 0, unexpectedConsoleErrors: 0 };
  const samples = [];
  const record = (kind, message) => {
    counts[kind]++;
    if (samples.length < 6) samples.push(`${kind}: ${message}`);
  };
  page.on('pageerror', error => record('errors', error.message));
  page.on('request', request => {
    const url = request.url();
    if (request.method() === 'POST') record('posts', url);
    if (!url.startsWith('data:') && new URL(url).origin !== origin) record('externalRequests', url);
  });
  page.on('console', message => {
    if (message.type() === 'error' && !message.text().includes("form-action 'none'")) {
      record('unexpectedConsoleErrors', message.text());
    }
  });

  for (const width of [360, 390]) for (const [id, name] of apps) {
    const label = `${id} at ${width}px`;
    await page.setViewportSize({ width, height: 844 });
    await page.goto(origin);
    await page.getByRole('button', { name: 'All apps', exact: true }).click();
    await page.getByRole('button', { name: `Explore ${name}`, exact: true }).first().click();
    await page.getByRole('button', { name: 'Try phone layout', exact: true }).click();
    const iframeElement = page.getByTitle(`${name} interactive example preview`, { exact: true });
    assert.deepEqual((await iframeElement.getAttribute('sandbox')).split(/\s+/).sort(), ['allow-forms', 'allow-scripts'], `${label}: sandbox permissions`);
    const ui = page.frameLocator(`iframe[title="${name} interactive example preview"]`);
    await ui.locator('.workbench').waitFor();
    const frame = page.frames().find(value => value.url() === new URL(`/demos/${id}/index.html`, origin).href);
    assert.ok(frame, `${label}: live preview frame`);
    const isolation = await frame.evaluate(() => {
      let storage, parentAccess;
      try { void localStorage; storage = 'accessible'; } catch (error) { storage = error.name; }
      try { void parent.document; parentAccess = 'accessible'; } catch (error) { parentAccess = error.name; }
      return { origin: self.origin, storage, parentAccess, keys: Object.getOwnPropertyNames(window.MatrixOS) };
    });
    assert.deepEqual(isolation, { origin: 'null', storage: 'SecurityError', parentAccess: 'SecurityError', keys: ['db'] }, `${label}: opaque, db-only boundary`);
    assert.match(await ui.locator('.demo-banner').innerText(), /Example data.*reset on reload/i);
    const measure = async () => frame.evaluate(() => {
      const undersized = [...document.querySelectorAll('button,input,select,textarea')]
        .filter(element => !element.disabled && element.getBoundingClientRect().height > 0)
        .map(element => {
          const rect = element.getBoundingClientRect();
          return { name: element.getAttribute('aria-label') || element.tagName, width: rect.width, height: rect.height };
        }).filter(control => control.width < 44 || control.height < 44);
      return { viewport: innerWidth, pageWidth: document.documentElement.scrollWidth, undersized };
    });
    const assertPhone = async () => {
      const size = await measure();
      assert.equal(size.pageWidth, size.viewport, `${label}: no document overflow`);
      assert.deepEqual(size.undersized, [], `${label}: every enabled control is at least 44×44px`);
    };
    await assertPhone();
    const definition = await frame.evaluate(() => JSON.parse(document.getElementById('matrix-app-definition').textContent));
    assert.equal(definition.fields[0].key, 'title', `${label}: genuine editor contract`);
    const readRows = async () => frame.evaluate(async () => window.MatrixOS.db.find('records'));
    const baseline = await readRows();
    assert.ok(baseline.length > 0, `${label}: fictional records loaded`);
    const title = `Temporary ${id} check ${width}`;
    await ui.getByRole('button', { name: /^\+ Add/ }).first().click();
    await ui.getByRole('dialog').waitFor();
    for (let index = 0; index < definition.fields.length; index++) {
      const field = definition.fields[index];
      const control = ui.locator('.editor > label').nth(index).locator('input,textarea,select');
      const value = field.key === 'title' ? title : field.key === 'currency' ? 'EUR'
        : field.kind === 'date' ? '2026-10-06' : field.kind === 'money' ? '12.34'
        : field.kind === 'number' ? '25' : field.kind === 'url' ? 'https://example.com' : 'Fictional check';
      if (field.kind === 'select') await control.selectOption(field.options[0]);
      else await control.fill(value);
    }
    await assertPhone();
    const sheet = await ui.locator('.sheet').evaluate(element => ({ width: element.clientWidth, scrollWidth: element.scrollWidth }));
    assert.equal(sheet.scrollWidth, sheet.width, `${label}: editor fields fit sheet`);
    await ui.getByRole('button', { name: 'Save record', exact: true }).click();
    await ui.getByRole('dialog').waitFor({ state: 'hidden' });
    const created = await readRows();
    assert.equal(created.length, baseline.length + 1, `${label}: exactly one UI-created fixture row`);
    assert.equal(created.filter(row => row.payload.fields.title === title).length, 1, `${label}: saved title`);
    await ui.getByRole('button', { name: 'Check records', exact: true }).click();
    await ui.getByLabel('Search records', { exact: true }).fill(title);
    await ui.getByRole('button', { name: /^Edit/ }).first().click();
    const titleControl = ui.locator('.editor > label').first().locator('input');
    assert.equal(await titleControl.inputValue(), title, `${label}: reopen preserved edit`);
    const revised = `${title} revised`;
    await titleControl.fill(revised);
    await ui.getByRole('button', { name: 'Save record', exact: true }).click();
    await ui.getByRole('dialog').waitFor({ state: 'hidden' });
    const edited = await readRows();
    assert.equal(edited.length, created.length, `${label}: edit did not duplicate`);
    assert.equal(edited.filter(row => row.payload.fields.title === revised).length, 1, `${label}: updated fixture title`);
    await frame.goto(new URL(`/demos/${id}/index.html`, origin).href);
    await ui.locator('.workbench').waitFor();
    assert.deepEqual(await readRows(), baseline, `${label}: reload restored exact fictional baseline`);

    // Test actual browser form navigation, not just a policy-string assertion.
    const action = new URL('/__demo-network-should-not-run', origin).href;
    const blocked = await frame.evaluate(async actionUrl => {
      const form = document.createElement('form');
      form.method = 'POST';
      form.action = actionUrl;
      document.body.append(form);
      let listener, timer;
      try {
        return await new Promise((resolve, reject) => {
          listener = event => {
            if (event.effectiveDirective === 'form-action') resolve({ directive: event.effectiveDirective, disposition: event.disposition, blockedURI: event.blockedURI });
          };
          document.addEventListener('securitypolicyviolation', listener);
          timer = setTimeout(() => reject(new Error('Browser did not report a blocked native form submission')), 1500);
          form.submit();
        });
      } finally {
        clearTimeout(timer);
        document.removeEventListener('securitypolicyviolation', listener);
        form.remove();
      }
    }, action);
    assert.deepEqual(blocked, { directive: 'form-action', disposition: 'enforce', blockedURI: action }, `${label}: native POST rejected by browser CSP`);
    assert.equal(frame.url(), new URL(`/demos/${id}/index.html`, origin).href, `${label}: no form navigation`);
    assert.deepEqual(counts, { errors: 0, externalRequests: 0, posts: 0, unexpectedConsoleErrors: 0 }, samples.join('\n'));
    completed++;
    console.log(`PASS ${label}: physical create/check/reopen/edit/reset; 44px; opaque; POST blocked`);
  }
  assert.equal(completed, 16);
  console.log('PASS 16/16 fictional browser preview flows. No owner persistence or Native Mobile proof.');
} finally {
  try { await context?.close(); } finally { await browser.close(); }
}
