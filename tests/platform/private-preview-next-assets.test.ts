import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { afterEach, expect, it, vi } from "vitest";
import type { NextConfig } from "next";
import { createClerkAuth } from "../../packages/platform/src/clerk-auth.js";
import { insertUserMachine } from "../../packages/platform/src/db.js";
import { createApp } from "../../packages/platform/src/main.js";
import { createTestPlatformDb, destroyTestPlatformDb } from "./native-platform-db-test-helper.js";
import { cookieHeaderFromSetCookie, stubOrchestrator } from "./proxy-routing-test-utils.js";

const nextWebpack = (createRequire(import.meta.url)("next/dist/compiled/webpack/bundle5") as () => { webpack: typeof import("webpack") })().webpack;
const previewHandle = "pv-3303-abcd1234";
const previewPage = `/vm/${previewHandle}`;
const chunk = "/_next/static/chunks/app/page-078ba9c537f00511.js";
const appOrigin = "https://app.matrix-os.com";
const ownerCookie = "__session=owner-session";
const appHost = "app.matrix-os.com";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetModules();
});

async function readShellConfig(input: { preview?: string; handle?: string; slot?: string; platform?: string; nodeEnv?: "development" | "production" }) {
  vi.stubEnv("NODE_ENV", input.nodeEnv ?? "production");
  vi.stubEnv("MATRIX_PREVIEW_RUNTIME", input.preview);
  vi.stubEnv("MATRIX_HANDLE", input.handle);
  vi.stubEnv("MATRIX_RUNTIME_SLOT", input.slot);
  vi.stubEnv("MATRIX_PLATFORM_AUTH_SHELL", input.platform);
  vi.stubEnv("POSTHOG_API_KEY", "");
  vi.stubEnv("POSTHOG_PROJECT_ID", "");
  return (await import("../../shell/next.config.ts")).default;
}

it.each([
  { preview: undefined, handle: previewHandle, slot: previewHandle },
  { preview: "true", handle: previewHandle, slot: "primary" },
  { preview: "true", handle: "pv-3303-abcd1234/extra", slot: "pv-3303-abcd1234/extra" },
  { preview: "true", handle: "owner", slot: "primary" },
  { preview: "true", handle: previewHandle, slot: previewHandle, nodeEnv: "development" as const },
])("leaves the default prefix without matching private Preview host identity %#", async input => {
  expect((await readShellConfig(input)).assetPrefix).toBeUndefined();
});

it("keeps the platform auth-shell prefix authoritative", async () => {
  const config = await readShellConfig({ preview: "true", handle: previewHandle, slot: previewHandle, platform: "1" });
  expect(config.assetPrefix).toBe("/__platform-shell");
  expect(config.env?.NEXT_PUBLIC_PLATFORM_SHELL_ASSET_PREFIX).toBe("/__platform-shell");
});

it.each([
  { dev: false, isServer: false, platform: undefined, relativeCss: true },
  { dev: true, isServer: false, platform: undefined, relativeCss: false },
  { dev: false, isServer: true, platform: undefined, relativeCss: false },
  { dev: false, isServer: false, platform: "1", relativeCss: false },
])("keeps the built public path and derives CSS assets only for the customer production browser compiler %#", async input => {
  const config = await readShellConfig({ platform: input.platform });
  const configureWebpack = config.webpack!;
  const extractionLoader = createRequire(import.meta.url).resolve("next/dist/compiled/mini-css-extract-plugin/loader");
  const cssAssets = { loader: extractionLoader, options: { publicPath: "/_next/" } };
  const customAssets = { loader: extractionLoader, options: { publicPath: "/custom/" } };
  const unrelated = { loader: "other-loader", options: { publicPath: "/_next/" } };
  const webpackConfig = {
    resolve: {},
    output: { publicPath: "built" },
    module: { rules: [{ oneOf: [{ rules: [{ use: [cssAssets, customAssets, unrelated] }] }] }] },
  } as Parameters<NonNullable<NextConfig["webpack"]>>[0];
  const context = { dev: input.dev, isServer: input.isServer, webpack: nextWebpack } as Parameters<typeof configureWebpack>[1];
  // Next copies output.publicPath into every client reference manifest as the
  // prefix for server-rendered chunk script tags, so it must stay the built
  // absolute path: "auto" rendered "autostatic/chunks/..." (404) in host bundles.
  expect(configureWebpack(webpackConfig, context).output.publicPath).toBe("built");
  expect(cssAssets.options.publicPath).toBe(input.relativeCss ? "auto" : "/_next/");
  expect(customAssets.options.publicPath).toBe("/custom/");
  expect(unrelated.options.publicPath).toBe("/_next/");
});

async function compileLazyChunkFixture(configureWebpack: NonNullable<NextConfig["webpack"]>) {
  const dir = await mkdtemp(join(tmpdir(), "matrix-shell-public-path-"));
  try {
    await writeFile(join(dir, "entry.js"), "import(/* webpackChunkName: \"lazy\" */ \"./lazy.js\");\n");
    await writeFile(join(dir, "lazy.js"), "export const value = 1;\n");
    const webpackConfig = configureWebpack({
      mode: "production",
      target: "web",
      context: dir,
      entry: { main: "./entry.js" },
      resolve: {},
      module: { rules: [] },
      output: {
        path: join(dir, "out"),
        publicPath: "/_next/",
        filename: "static/chunks/[name].js",
        chunkFilename: "static/chunks/[name].js",
      },
      optimization: { minimize: false, runtimeChunk: { name: "webpack" } },
    } as Parameters<NonNullable<NextConfig["webpack"]>>[0], { dev: false, isServer: false, webpack: nextWebpack } as Parameters<NonNullable<NextConfig["webpack"]>>[1]);
    const stats = await new Promise<import("webpack").Stats>((resolvePromise, reject) => {
      nextWebpack(webpackConfig, (error, result) => error || !result ? reject(error) : resolvePromise(result));
    });
    expect(stats.hasErrors()).toBe(false);
    return {
      publicPath: stats.compilation.outputOptions.publicPath,
      runtime: await readFile(join(dir, "out/static/chunks/webpack.js"), "utf8"),
      main: await readFile(join(dir, "out/static/chunks/main.js"), "utf8"),
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function lazyChunkUrlFor(bundle: { runtime: string; main: string }, runtimeScriptSrc: string): string | undefined {
  const requested: string[] = [];
  const document = {
    currentScript: null as null | { tagName: string; src: string },
    getElementsByTagName: () => [],
    createElement: () => ({ setAttribute() {}, parentNode: null }),
    head: { appendChild: (script: { src: string }) => { requested.push(script.src); } },
  };
  const context: Record<string, unknown> = { document, setTimeout, clearTimeout };
  context.self = context;
  context.window = context;
  document.currentScript = { tagName: "SCRIPT", src: runtimeScriptSrc };
  runInNewContext(bundle.runtime, context);
  document.currentScript = { tagName: "SCRIPT", src: runtimeScriptSrc.replace("webpack.js", "main.js") };
  runInNewContext(bundle.main, context);
  return requested[0];
}

it("loads lazy chunks from the served runtime script while server-rendered chunk tags keep the absolute Next path", async () => {
  const config = await readShellConfig({});
  const bundle = await compileLazyChunkFixture(config.webpack!);
  expect(bundle.publicPath).toBe("/_next/");
  expect(lazyChunkUrlFor(bundle, `${appOrigin}${previewPage}/_next/static/chunks/webpack.js`))
    .toBe(`${appOrigin}${previewPage}/_next/static/chunks/lazy.js`);
  expect(lazyChunkUrlFor(bundle, "https://owner.example/_next/static/chunks/webpack.js"))
    .toBe("https://owner.example/_next/static/chunks/lazy.js");
}, 30_000);

it("loads the Preview document's own Next chunk after another tab changes the shell route cookies", async () => {
  vi.stubEnv("MATRIX_LEGACY_CONTAINER_ROUTING_ENABLED", "false");
  const config = await readShellConfig({ preview: "true", handle: previewHandle, slot: previewHandle });
  expect(config.env?.NEXT_PUBLIC_PLATFORM_SHELL_ASSET_PREFIX).toBe("");
  const { db } = await createTestPlatformDb();
  try {
    const common = { clerkUserId: "user_owner", status: "running" as const,
      imageVersion: "bundle", provisionedAt: "2026-11-12T09:00:00.000Z", activationState: "authorized" as const };
    await insertUserMachine(db, { ...common, machineId: "machine_owner", handle: "owner",
      runtimeSlot: "primary", publicIPv4: "203.0.113.11" });
    await insertUserMachine(db, { ...common, machineId: "machine_preview", handle: previewHandle, runtimeSlot: previewHandle,
      provisioningClass: "private-preview", sourcePr: 3303, confirmedBundleVersion: "preview-bundle", publicIPv4: "203.0.113.33" });
    const upstream = vi.spyOn(globalThis, "fetch").mockImplementation(async input => {
      const url = new URL(String(input));
      if (url.pathname === "/") {
        const assetPrefix = url.hostname === "203.0.113.33" ? config.assetPrefix ?? "" : "";
        return new Response(`<html><script src="${assetPrefix}${chunk}"></script></html>`, {
          headers: { "content-type": "text/html" },
        });
      }
      if (url.hostname === "203.0.113.33" && url.pathname === chunk) {
        return new Response("preview chunk", { headers: { "content-type": "application/javascript" } });
      }
      return new Response("Not Found", { status: 404 });
    });
    const app = createApp({ db, orchestrator: stubOrchestrator(), platformSecret: "test-preview-platform-secret",
      clerkAuth: createClerkAuth({ verifyToken: vi.fn(async () => ({ sub: "user_owner" })) }) });
    const preview = await app.request(appOrigin + previewPage, { headers: { host: appHost, cookie: ownerCookie } });
    expect(preview.status).toBe(200);
    const src = /src="([^"]+)"/.exec(await preview.text())?.[1];
    expect(src).toBe(`${previewPage}${chunk}`);

    const main = await app.request(appOrigin + "/vm/owner", { headers: { host: appHost, cookie: ownerCookie } });
    expect(main.status).toBe(200);
    const cookie = [ownerCookie, cookieHeaderFromSetCookie(main.headers, ["matrix_shell_route", "matrix_shell_runtime_slot"])].join("; ");
    expect(cookie).toContain("matrix_shell_route=owner");
    const asset = await app.request(appOrigin + src, { headers: { host: appHost, cookie, referer: appOrigin + previewPage } });
    expect(asset.status).toBe(200);
    expect(await asset.text()).toBe("preview chunk");
    expect(String(upstream.mock.calls.at(-1)?.[0])).toBe(`https://203.0.113.33:443${chunk}`);

    upstream.mockClear();
    const anonymous = await app.request(appOrigin + src, { headers: { host: appHost } });
    expect(anonymous.status).toBeGreaterThanOrEqual(300);
    expect(upstream.mock.calls.map(([request]) => new URL(String(request)).hostname)).not.toContain("203.0.113.33");
  } finally {
    await destroyTestPlatformDb(db);
  }
});
