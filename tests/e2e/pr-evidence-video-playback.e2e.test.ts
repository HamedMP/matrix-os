import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { createRequire } from "node:module";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createEvidenceKey } from "../../packages/pr-evidence-worker/src/keys.js";
import { SERVED_CSP } from "../../packages/pr-evidence-worker/src/worker.js";
import { makeWorker } from "../pr-evidence-worker/helpers.js";

// Outcome: a reviewer who opens a recording link sees it play and can seek.
// Fault detected: a served CSP that blocks the browser's media document (readyState stays 0).
const require = createRequire(new URL("../../shell/package.json", import.meta.url));
const VIDEO = readFileSync(new URL("../fixtures/pr-evidence/h264-3s.mp4", import.meta.url));

interface Served {
  url: string;
  ranges: string[];
  close(): Promise<void>;
}

async function serveEvidence(overrideCsp?: string): Promise<Served> {
  const worker = makeWorker();
  const key = createEvidenceKey(3551, "abcdef1", "video/mp4");
  worker.bucket.objects.set(key, { bytes: new Uint8Array(VIDEO), contentType: "video/mp4" });
  const ranges: string[] = [];
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers)) if (typeof value === "string") headers.set(name, value);
      if (headers.has("range")) ranges.push(headers.get("range")!);
      const response = await worker.handle(new Request(`http://127.0.0.1${req.url}`, { method: req.method, headers }), worker.env);
      const out: Record<string, string> = {};
      response.headers.forEach((value, name) => {
        out[name] = value;
      });
      if (overrideCsp) out["content-security-policy"] = overrideCsp;
      res.writeHead(response.status, out);
      res.end(Buffer.from(await response.arrayBuffer()));
    })().catch((error: unknown) => {
      console.error("[pr-evidence-e2e] handler failed", error);
      res.writeHead(500).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/${key}`,
    ranges,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

describe("PR evidence video playback in Chromium", () => {
  let browser: { newPage(): Promise<any>; close(): Promise<void> };

  beforeAll(async () => {
    const { chromium } = require("@playwright/test");
    browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE, headless: true });
  });

  afterAll(async () => {
    await browser?.close();
  });

  it("plays and seeks an H.264 recording opened directly under the production headers", async () => {
    const served = await serveEvidence();
    const page = await browser.newPage();
    try {
      const response = await page.goto(served.url);
      expect(response.headers()["content-security-policy"]).toContain("media-src 'self'");
      // rAF polling does not tick inside a media document; poll on an interval instead.
      await page.waitForFunction(() => (document.querySelector("video")?.readyState ?? 0) === 4, null, { polling: 100, timeout: 15_000 });
      const duration = await page.evaluate(() => document.querySelector("video")!.duration);
      expect(duration).toBeGreaterThan(2.5);
      // CSP `sandbox` disables page scripting, so event listeners and timers never run
      // inside the media document; drive the seek and poll its state from the test.
      await page.evaluate(() => {
        document.querySelector("video")!.currentTime = 2;
      });
      let seekState = { seeking: true, currentTime: 0, readyState: 0 };
      for (let i = 0; i < 100 && (seekState.seeking || seekState.readyState < 2); i += 1) {
        await page.waitForTimeout(100);
        seekState = await page.evaluate(() => {
          const video = document.querySelector("video")!;
          return { seeking: video.seeking, currentTime: video.currentTime, readyState: video.readyState };
        });
      }
      expect(seekState.seeking).toBe(false);
      expect(seekState.readyState).toBeGreaterThanOrEqual(2);
      const seeked = seekState.currentTime;
      expect(seeked).toBeCloseTo(2, 0);
      // A small fixture downloads in one response, so prove the byte-range path
      // the browser uses for larger recordings through the same production handler.
      // The media document's CSP blocks fetch(), so issue it from a same-origin page.
      const probe = await browser.newPage();
      await probe.goto(new URL("/", served.url).href);
      const partial = await probe.evaluate(async (url: string) => {
        const res = await fetch(url, { headers: { Range: "bytes=1000-1999" } });
        return { status: res.status, range: res.headers.get("content-range"), length: (await res.arrayBuffer()).byteLength };
      }, served.url);
      await probe.close();
      expect(partial).toEqual({ status: 206, range: `bytes 1000-1999/${VIDEO.byteLength}`, length: 1000 });
      expect(served.ranges).toContain("bytes=1000-1999");
    } finally {
      await page.close();
      await served.close();
    }
  });

  it("control: the old image policy leaves the recording unplayable", async () => {
    const served = await serveEvidence(SERVED_CSP);
    const page = await browser.newPage();
    try {
      await page.goto(served.url);
      await page.waitForTimeout(2_000);
      expect(await page.evaluate(() => document.querySelector("video")?.readyState ?? 0)).toBe(0);
    } finally {
      await page.close();
      await served.close();
    }
  });
});
