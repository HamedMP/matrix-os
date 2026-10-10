import { createRequire } from "node:module";
import { expect, it } from "vitest";
import { APP_IFRAME_SANDBOX, injectBridgeIntoAppHtml } from "../../shell/src/components/app-viewer-helpers.js";

const require = createRequire(new URL("../../shell/package.json", import.meta.url));

it("runs local analysis under the real opaque app policy without external workers or network access", async () => {
  const { chromium } = require("@playwright/test");
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const page = await browser.newPage();
    const externalRequests: string[] = [];
    await page.route("**/*", async (route: { request(): { url(): string }; fulfill(value: { body: string; contentType: string }): Promise<void>; abort(): Promise<void> }) => {
      const url = route.request().url();
      if (url === "https://matrix-policy.test/") await route.fulfill({ body: "<!doctype html><html><body></body></html>", contentType: "text/html" });
      else { externalRequests.push(url); await route.abort(); }
    });
    await page.goto("https://matrix-policy.test/");
    const html = injectBridgeIntoAppHtml(`<html><head></head><body><script>
      let parentBlocked = false, externalWorkerBlocked = false;
      try { parent.document.body; } catch { parentBlocked = true; }
      try { new Worker('https://outside.invalid/worker.js'); } catch { externalWorkerBlocked = true; }
      const source = "fetch('https://outside.invalid/', {signal: AbortSignal.timeout(500)}).then(() => postMessage({networkBlocked:false}), () => postMessage({score:6*7, networkBlocked:true, origin:self.origin}))";
      const url = URL.createObjectURL(new Blob([source], {type:'text/javascript'}));
      const worker = new Worker(url);
      worker.onmessage = event => {
        parent.postMessage({type:'local-analysis', ...event.data, parentBlocked, externalWorkerBlocked}, '*');
        worker.terminate(); URL.revokeObjectURL(url);
      };
      worker.onerror = () => parent.postMessage({type:'local-analysis', failed:true}, '*');
    </script></body></html>`, "chess-coach", {}, "/apps/chess-coach/");
    await page.evaluate(({ html, sandbox }: { html: string; sandbox: string }) => {
      window.addEventListener("message", event => {
        if (event.data?.type === "local-analysis") (window as Window & { analysisResult?: unknown }).analysisResult = event.data;
      });
      const frame = document.createElement("iframe");
      frame.setAttribute("sandbox", sandbox); frame.srcdoc = html; document.body.append(frame);
    }, { html, sandbox: APP_IFRAME_SANDBOX });
    await page.waitForFunction(() => Boolean((window as Window & { analysisResult?: unknown }).analysisResult), null, { timeout: 5000 });
    const result = await page.evaluate(() => (window as Window & { analysisResult?: unknown }).analysisResult);
    expect(result).toMatchObject({ score: 42, networkBlocked: true, origin: "null", parentBlocked: true, externalWorkerBlocked: true });
    expect(externalRequests).toEqual([]);
    expect(APP_IFRAME_SANDBOX).not.toContain("allow-same-origin");
  } finally { await browser.close(); }
}, 15000);
