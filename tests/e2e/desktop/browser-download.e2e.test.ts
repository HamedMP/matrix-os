import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { chromium } from "playwright";
import { startDownloadGateway } from "./fixtures/download-gateway";

const root = resolve(__dirname, "../../..");
const viteRequire = createRequire(resolve(root, "node_modules/vite/package.json"));
const { build } = viteRequire("esbuild") as typeof import("esbuild");

describe("browser download manager with the real Gateway stream", () => {
  it("saves a 64 MiB attachment through session cookies without a page Blob", async () => {
    const gateway = await startDownloadGateway();
    const browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHROMIUM_CHANNEL || "chrome" });
    try {
      const page = await browser.newPage({ acceptDownloads: true });
      await page.goto(`${gateway.url}/download-review`);
      const bundle = await build({ entryPoints: [resolve(root, "shell/src/lib/file-download.ts")], bundle: true, format: "iife", globalName: "FileDownloads", platform: "browser", write: false });
      await page.addScriptTag({ content: bundle.outputFiles[0]!.text });
      await page.evaluate((filename) => {
        URL.createObjectURL = () => { throw new Error("Page must not buffer downloads"); };
        const factory = (window as unknown as { FileDownloads: { createBrowserFileDownload: (url: string) => { download: (input: unknown) => Promise<{ status: string }> } } }).FileDownloads;
        const client = factory.createBrowserFileDownload(location.origin);
        document.getElementById("download")!.onclick = async () => {
          const result = await client.download({ path: filename, requestId: crypto.randomUUID(), signal: new AbortController().signal });
          document.getElementById("status")!.textContent = result.status;
        };
      }, gateway.filename);
      const pending = page.waitForEvent("download");
      await page.getByRole("button", { name: "Download", exact: true }).click();
      const download = await pending;
      expect(download.suggestedFilename()).toBe(gateway.filename);
      expect(await download.failure()).toBeNull();
      const path = await download.path();
      expect(path).toBeTruthy();
      const bytes = await readFile(path!);
      expect(bytes.length).toBe(gateway.size);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(gateway.sha256);
      expect(await page.locator("#status").textContent()).toBe("handed_off");
      expect(gateway.requestCount()).toBe(1);
      expect((await page.request.get(`${gateway.url}/api/files/media?path=${gateway.filename}&download=true`, { headers: { Cookie: "" } })).status()).toBe(401);
    } finally { await browser.close(); await gateway.close(); }
  }, 60_000);
});
