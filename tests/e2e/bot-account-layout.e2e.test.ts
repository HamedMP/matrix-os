import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { compile } from "@tailwindcss/node";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { Browser } from "playwright";
import { BotEditorApps } from "../../packages/ui/src/chat-agents/bots/BotEditorApps";

const root = resolve(import.meta.dirname, "../..");
const { chromium } = createRequire(resolve(root, "packages/mcp-browser/package.json"))("playwright") as typeof import("playwright");
let browser: Browser;
let css: string;
const label = "Personal - example-account";
const email = "example-account@gmail.com";

beforeAll(async () => {
  const source = await readFile(resolve(root, "packages/ui/src/chat-agents/bots/BotEditorApps.tsx"), "utf8");
  const tailwind = await compile('@import "tailwindcss";', { base: root, onDependency() {} });
  css = tailwind.build([...source.matchAll(/className="([^"]+)"/g)].flatMap(match => match[1].split(/\s+/)));
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
});
afterAll(async () => browser?.close());

it.each([309, 220])("keeps account names, emails and access status readable in a %ipx editor region", async width => {
  const page = await browser.newPage();
  const authority = { agentId: "bot_research1", revision: 1, grants: [], routines: [], pendingInteractions: [], memory: { items: [] },
    connections: [{ service: "gmail", serviceName: "Gmail", state: "connected_not_granted" as const,
      accounts: [{ displayKey: "acct_aaaaaaaaaaaaaaaaaaaaaaaa", label, email, state: "connected_not_granted" as const }] }] };
  try {
    const html = renderToStaticMarkup(React.createElement(BotEditorApps, { agentId: authority.agentId, authority }));
    await page.setContent(`<style>${css} body { font-family: Arial, sans-serif; } #editor { width: ${width}px; }</style><main id="editor">${html}</main>`);
    for (const text of [label, email, "Permission required"]) {
      const box = await page.getByText(text, { exact: true }).evaluate(element => ({
        width: element.clientWidth, scrollWidth: element.scrollWidth, height: element.clientHeight,
        right: element.getBoundingClientRect().right,
        regionRight: document.querySelector("#editor")!.getBoundingClientRect().right,
      }));
      expect(box.height, text).toBeGreaterThan(0);
      expect(box.scrollWidth, text).toBeLessThanOrEqual(box.width);
      expect(box.right, text).toBeLessThanOrEqual(box.regionRight);
    }
  } finally { await page.close(); }
});
