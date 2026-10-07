import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { Browser } from "playwright";
import { DESKTOP_Z_INDEX } from "../../../desktop/src/renderer/src/design/layering";

const { chromium } = createRequire(new URL("../../../shell/package.json", import.meta.url))("@playwright/test");
let browser: Browser;
let css: string;
beforeAll(async () => {
  css = await readFile(new URL("../../../desktop/src/renderer/src/design/chat.css", import.meta.url), "utf8")
    + await readFile(new URL("../../../packages/ui/src/chat-agents/chat-agents.css", import.meta.url), "utf8");
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
});
afterAll(async () => browser?.close());

it("does not raise wide hosted Details or another shared consumer", async () => {
  const page = await browser.newPage();
  try {
    await page.setContent(`<style>${css}</style>
      <section data-bot-details-host data-bot-details-reserved="true" style="--matrix-bot-details-overlay-layer:${DESKTOP_Z_INDEX.popover}"><aside class="matrix-bot-details matrix-bot-details--hosted" aria-label="Wide details"></aside></section>
      <section data-bot-details-reserved="false" style="--matrix-bot-details-overlay-layer:${DESKTOP_Z_INDEX.popover}"><aside class="matrix-bot-details matrix-bot-details--hosted" aria-label="Other details"></aside></section>`);
    const layers = await page.locator("aside").evaluateAll(elements => elements.map(element => getComputedStyle(element).zIndex));
    expect(layers).toEqual(["10", "10"]);
  } finally { await page.close(); }
});

it("keeps narrow hosted Details close/edit clickable above overlapping app actions and restores those actions on close", async () => {
  const page = await browser.newPage({ viewport: { width: 600, height: 700 } });
  try {
    // Reproduce the actual OSWindow sibling stacking: body/host, then z-20 chrome.
    await page.setContent(`<style>${css}
      * { box-sizing: border-box; } body { margin: 0; }
      [data-os-window-clip] { position: relative; height: 662px; margin-top: 38px; }
      [data-os-window-body] { position: absolute; inset: 0; }
      [data-testid] { position: relative; margin-left: 240px; height: 100%; }
      [data-os-window-top-bar-overlay] { position: absolute; inset: 0 0 auto; height: 48px; z-index: 20; pointer-events: none; }
      [data-os-window-actions] { position: absolute; right: 24px; top: 24px; pointer-events: auto; }
      button { height: 28px; } aside header { display: flex; justify-content: flex-end; }
    </style><section data-os-window-clip><div data-os-window-body>
      <div data-testid="desktop-surface-content-work" data-bot-details-host data-bot-details-reserved="false" style="--matrix-bot-details-overlay-layer:${DESKTOP_Z_INDEX.popover}">
        <aside aria-label="Bot details" class="matrix-bot-details matrix-bot-details--hosted"><header><button aria-label="Close bot details">×</button></header><button aria-label="Edit bot">Edit bot</button></aside>
      </div></div><div data-os-window-top-bar-overlay><div data-os-window-actions><button aria-label="Share">Share</button></div></div></section>`);
    await page.evaluate(() => {
      document.querySelector('[aria-label="Edit bot"]')?.addEventListener("click", () => document.body.setAttribute("data-edited", "true"));
      document.querySelector('[aria-label="Close bot details"]')?.addEventListener("click", () => {
        document.querySelector("aside")?.remove();
        document.querySelector("[data-bot-details-reserved]")?.removeAttribute("data-bot-details-reserved");
      });
      document.querySelector('[aria-label="Share"]')?.addEventListener("click", () => document.body.setAttribute("data-shared", "true"));
    });
    await page.getByRole("button", { name: "Edit bot", exact: true }).click({ timeout: 1500 });
    expect(await page.locator("body").getAttribute("data-edited")).toBe("true");
    await page.getByRole("button", { name: "Close bot details" }).click({ timeout: 1500 });
    expect(await page.getByRole("complementary", { name: "Bot details" }).count()).toBe(0);
    await page.getByRole("button", { name: "Share", exact: true }).click({ timeout: 1500 });
    expect(await page.locator("body").getAttribute("data-shared")).toBe("true");
  } finally { await page.close(); }
});
