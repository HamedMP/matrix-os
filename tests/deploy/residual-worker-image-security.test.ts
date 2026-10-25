import { createRequire } from "node:module";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const edge = createRequire(new URL("../../packages/edge-router/package.json", import.meta.url));
const wrangler = createRequire(edge.resolve("wrangler"));
const miniflare = createRequire(wrangler.resolve("miniflare"));
const { Miniflare, convertV4MiniflareOptions } = wrangler("miniflare");
const sharp = miniflare("sharp");
function atLeast(actual: string, minimum: string): boolean {
  const a = actual.split(".").map(Number), b = minimum.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! > b[i]!;
  return true;
}

describe("actual Wrangler-selected image decoder libraries", () => {
  it.each([["vips", "8.18.3"], ["heif", "1.23.2"], ["rsvg", "2.63.2"]])("loads fixed %s native code", (library, minimum) => {
    expect(typeof sharp.versions[library]).toBe("string");
    expect(atLeast(sharp.versions[library], minimum), JSON.stringify(sharp.versions)).toBe(true);
  });
  it("rejects truncated image bytes and enforces an explicit pixel limit", async () => {
    await expect(sharp(Buffer.from("89504e470d0a1a0a", "hex")).toBuffer()).rejects.toThrow();
    const oversized = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="1000"><rect width="1000" height="1000"/></svg>');
    await expect(sharp(oversized, { limitInputPixels: 64 }).png().toBuffer()).rejects.toThrow(/pixel limit/);
  });
  it("retains SVG, PNG, AVIF encode/decode and resizing", async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="17" height="23"><rect width="17" height="23" fill="red"/></svg>');
    const png = await sharp(svg).resize(8, 6).png().toBuffer();
    expect(await sharp(png).metadata()).toMatchObject({ width: 8, height: 6, format: "png" });
    const avif = await sharp(png).avif().toBuffer();
    expect(await sharp(avif).metadata()).toMatchObject({ width: 8, height: 6, format: "heif" });
  });
});

describe("vendor-supported Miniflare and workerd consumer contract", () => {
  let emulator: InstanceType<typeof Miniflare>;
  beforeAll(async () => {
    // The parent-selected Miniflare 5 publishes this migration bridge;
    // exercise it explicitly instead of assuming the v4 constructor still works.
    emulator = new Miniflare(convertV4MiniflareOptions({
      host: "127.0.0.1", port: 0, modules: true, compatibilityDate: "2026-06-06",
      script: `export default { async fetch(request, env) {
        if (new URL(request.url).pathname === '/health') return new Response('local-worker-ready');
        try { return Response.json(await env.IMAGES.info(request.body)); }
        catch { return new Response('invalid image', { status: 400 }); }
      } }`,
      images: { binding: "IMAGES" },
    }));
    await emulator.ready;
  }, 30_000);
  afterAll(async () => { await emulator?.dispose(); });
  it("serves health over its actual loopback HTTP listener and worker dispatch", async () => {
    const health = new URL("/health", await emulator.ready);
    expect(health.protocol).toBe("http:");
    expect(health.hostname).toBe("127.0.0.1");
    expect(Number(health.port)).toBeGreaterThan(0);
    expect(Number(health.port)).toBeLessThanOrEqual(65535);
    const listening = await fetch(health, { signal: AbortSignal.timeout(3_000), redirect: "error" });
    expect(listening.status).toBe(200);
    expect(await listening.text()).toBe("local-worker-ready");
    const dispatched = await emulator.dispatchFetch("https://local.invalid/health");
    expect(dispatched.status).toBe(200);
    expect(await dispatched.text()).toBe("local-worker-ready");
  });
  it("runs the actual Images binding through workerd and Sharp", async () => {
    const png = await sharp({ create: { width: 17, height: 23, channels: 3, background: "red" } }).png().toBuffer();
    const response = await emulator.dispatchFetch("https://local.invalid/info", { method: "POST", body: png });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ width: 17, height: 23, format: "image/png" });
  });
  it("rejects invalid image data across the real binding", async () => {
    const response = await emulator.dispatchFetch("https://local.invalid/info", { method: "POST", body: "not an image" });
    expect(response.status).toBe(400);
    expect(await response.text()).toBe("invalid image");
  });
});
