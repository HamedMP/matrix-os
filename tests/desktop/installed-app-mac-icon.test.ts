import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildShimIcon, fetchGatewayIcon, MAX_ICON_BYTES } from "@desktop/main/installed-apps/mac-icon";

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("png-body")]);
const FALLBACK = Buffer.from("icns-fallback");

function response(body: Uint8Array, init: { status?: number; type?: string } = {}) {
  return new Response(body, { status: init.status ?? 200, headers: { "content-type": init.type ?? "image/png" } });
}

describe("fetching an app icon from the gateway", () => {
  beforeEach(() => { vi.spyOn(console, "warn").mockImplementation(() => undefined); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("requests /icons/<slug>.png with the owner token, a timeout and no redirects", async () => {
    const fetchFn = vi.fn(async () => response(PNG));
    const icon = await fetchGatewayIcon({ fetchFn, gatewayOrigin: "https://gw.test", token: "t0k", slug: "notes" });
    expect(icon).toEqual(new Uint8Array(PNG));
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://gw.test/icons/notes.png");
    expect(init.redirect).toBe("error");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer t0k");
  });

  it.each([
    ["a failed response", () => response(PNG, { status: 404 })],
    ["an SVG", () => response(Buffer.from("<svg/>"), { type: "image/svg+xml" })],
    ["a body that is not a PNG", () => response(Buffer.from("not a png"))],
    ["an oversized icon", () => response(Buffer.concat([PNG, Buffer.alloc(MAX_ICON_BYTES)]))],
  ])("returns null for %s", async (_label, make) => {
    const icon = await fetchGatewayIcon({ fetchFn: async () => make(), gatewayOrigin: "https://gw.test", token: null, slug: "notes" });
    expect(icon).toBeNull();
  });

  it("returns null when the request fails", async () => {
    const fetchFn = async () => { throw new TypeError("network down"); };
    expect(await fetchGatewayIcon({ fetchFn, gatewayOrigin: "https://gw.test", token: null, slug: "notes" })).toBeNull();
  });

  it("never requests a path-like slug", async () => {
    const fetchFn = vi.fn(async () => response(PNG));
    expect(await fetchGatewayIcon({ fetchFn, gatewayOrigin: "https://gw.test", token: null, slug: "../x" })).toBeNull();
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe("building the shim icon", () => {
  let dir: string;
  let fallbackPath: string;
  beforeEach(async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    dir = await mkdtemp(join(tmpdir(), "mac-icon-test-"));
    fallbackPath = join(dir, "matrix.icns");
    await writeFile(fallbackPath, FALLBACK);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  // Stands in for sips (writes each size) and iconutil (writes the .icns).
  const fakeTools = () => vi.fn(async (file: string, args: readonly string[]) => {
    if (file === "/usr/bin/sips") await writeFile(args[args.indexOf("--out") + 1]!, "size");
    if (file === "/usr/bin/iconutil") await writeFile(args[args.indexOf("-o") + 1]!, "converted-icns");
  });

  it("converts the PNG with sips and iconutil, without a shell, under one timeout, and cleans up", async () => {
    const execFile = fakeTools();
    const scratch = join(dir, "scratch");
    const icon = await buildShimIcon({ png: new Uint8Array(PNG), fallbackIcnsPath: fallbackPath, execFile, tmpDir: scratch });
    expect(Buffer.from(icon).toString()).toBe("converted-icns");
    const sips = execFile.mock.calls.filter(([file]) => file === "/usr/bin/sips");
    expect(sips).toHaveLength(10);
    expect(sips.map(([, args]) => args[args.indexOf("--out") + 1]!.split("/").pop()).sort()).toContain("icon_512x512@2x.png");
    const iconutil = execFile.mock.calls.find(([file]) => file === "/usr/bin/iconutil")!;
    expect(iconutil[1].slice(0, 2)).toEqual(["-c", "icns"]);
    for (const call of execFile.mock.calls) expect((call as unknown as [string, string[], { signal: AbortSignal }])[2].signal).toBeInstanceOf(AbortSignal);
    expect(await readdir(scratch)).toEqual([]);
  });

  it("uses the Matrix icon when there is no PNG", async () => {
    const execFile = fakeTools();
    const icon = await buildShimIcon({ png: null, fallbackIcnsPath: fallbackPath, execFile, tmpDir: join(dir, "scratch") });
    expect(Buffer.from(icon)).toEqual(FALLBACK);
    expect(execFile).not.toHaveBeenCalled();
  });

  it("uses the Matrix icon when the conversion fails", async () => {
    const execFile = vi.fn(async () => { throw new Error("sips crashed"); });
    const icon = await buildShimIcon({ png: new Uint8Array(PNG), fallbackIcnsPath: fallbackPath, execFile, tmpDir: join(dir, "scratch") });
    expect(Buffer.from(icon)).toEqual(FALLBACK);
  });
});
