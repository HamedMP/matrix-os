import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { Browser } from 'playwright';
import { ConnectionMethodCard } from '../../../packages/ui/src/agents-providers/ConnectionMethodCard';

const { chromium } = createRequire(new URL('../../../shell/package.json', import.meta.url))('@playwright/test');
let browser: Browser;
let css: string;
beforeAll(async () => {
  css = await readFile(new URL('../../../packages/ui/src/agents-providers/agents-providers.css', import.meta.url), 'utf8');
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
});
afterAll(async () => browser?.close());

// Fault detected: an absolute selection/loading indicator covers long login copy.
it.each([280, 310, 400])('keeps terminal-login text clear of its indicator in a %ipx card', async width => {
  const page = await browser.newPage();
  try {
    for (const loading of [false, true]) {
      const markup = renderToStaticMarkup(createElement(ConnectionMethodCard, {
        method: 'account', title: 'ChatGPT account · Log in in Terminal',
        description: 'Sign in with your account in Terminal', selected: true, loading, disabled: false,
      }));
      await page.setContent(`<style>${css}</style><main class="matrix-agents-providers" style="width:${width}px;font-family:Arial">${markup}</main>`);
      const result = await page.locator('button').evaluate(button => {
        const check = button.querySelector('.matrix-ap-method-check')!.getBoundingClientRect();
        const bounds = button.getBoundingClientRect();
        const range = document.createRange();
        range.selectNodeContents(button.querySelector('.matrix-ap-method-copy')!);
        const rectangles = Array.from(range.getClientRects());
        return {
          overlaps: rectangles.some(r => r.left < check.right && r.right > check.left && r.top < check.bottom && r.bottom > check.top),
          inside: rectangles.every(r => r.left >= bounds.left && r.right <= bounds.right),
          overflow: button.scrollWidth > button.clientWidth,
        };
      });
      expect(result, `loading=${loading}`).toEqual({ overlaps: false, inside: true, overflow: false });
    }
  } finally { await page.close(); }
});
