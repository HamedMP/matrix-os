import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { APP_FILE_ERROR_MESSAGES, APP_FILES_BRIDGE_PATH, MAX_APP_FILE_REQUEST_BYTES } from "../../../packages/contracts/src/app-files";
import { registerBridgeFileRoutes } from "../../../packages/gateway/src/server/bridge-file-routes";
import { createHarness, errorCode, installApp, type AppFileHarness } from "./helpers";

let harness: AppFileHarness | null = null;
afterEach(async () => { await harness?.cleanup(); harness = null; });

async function listStatus(h: AppFileHarness, app = "docs"): Promise<[number, string]> {
  const response = await h.post({ kind: "files.list", dir: "" }, app);
  return [response.status, response.status === 200 ? "ok" : await errorCode(response)];
}

describe("app file access policy", () => {
  it("allows a first-party personal app that declares the files permission", async () => {
    harness = await createHarness();
    await writeFile(join(harness.home, "notes.txt"), "hi");
    expect(await listStatus(harness)).toEqual([200, "ok"]);
  });

  it.each([
    ["no files permission", { permissions: [] }],
    ["another permission only", { permissions: ["network"] }],
    ["third-party app", { listingTrust: "community" }],
    ["missing listing trust", { listingTrust: undefined as unknown as string }],
    ["hidden app", { hidden: true }],
    ["shared-scope app", { scope: "shared" }],
    ["installed from the gallery", { provenance: { installed_from: { slug: "docs", installedAt: "2026-10-27T00:00:00.000Z" } } }],
    ["forked app", { provenance: { forked_from: { author: "@friend", slug: "docs", version: "1.0.0" } } }],
  ])("forbids %s", async (_label, install) => {
    harness = await createHarness({ install });
    if (install.listingTrust === undefined && "listingTrust" in install) {
      await writeFile(join(harness.home, "apps/docs/matrix.json"), JSON.stringify({
        name: "docs", slug: "docs", version: "1.0.0", runtime: "static", runtimeVersion: "^1.0.0", permissions: ["files"],
      }));
    }
    expect(await listStatus(harness)).toEqual([403, "forbidden"]);
  });

  it("forbids an app that is not installed and an app name that differs from the manifest", async () => {
    harness = await createHarness();
    expect(await listStatus(harness, "sheets")).toEqual([403, "forbidden"]);
  });

  it("forbids duplicate slugs because the identity is ambiguous", async () => {
    harness = await createHarness();
    await installApp(harness.home, { slug: "docs-copy" });
    await writeFile(join(harness.home, "apps/docs-copy/matrix.json"), JSON.stringify({
      name: "docs", slug: "docs", version: "1.0.0", runtime: "static", runtimeVersion: "^1.0.0",
      listingTrust: "first_party", permissions: ["files"],
    }));
    expect(await listStatus(harness)).toEqual([403, "forbidden"]);
  });

  it("forbids a principal that is not the owner and a missing principal", async () => {
    harness = await createHarness();
    harness.owner.id = "intruder";
    expect(await listStatus(harness)).toEqual([403, "forbidden"]);
    harness.owner.id = null;
    expect(await listStatus(harness)).toEqual([403, "forbidden"]);
  });

  it("re-reads the manifest so a revoked permission takes effect immediately", async () => {
    harness = await createHarness();
    expect((await listStatus(harness))[0]).toBe(200);
    await writeFile(join(harness.home, "apps/docs/matrix.json"), JSON.stringify({
      name: "docs", slug: "docs", version: "1.0.0", runtime: "static", runtimeVersion: "^1.0.0",
      listingTrust: "first_party", permissions: [],
    }));
    expect(await listStatus(harness)).toEqual([403, "forbidden"]);
  });

  it("replies unavailable, not not-found, when no home path is configured", async () => {
    harness = await createHarness({ homePath: "" });
    expect(await listStatus(harness)).toEqual([503, "unavailable"]);
  });

  it("rejects malformed bodies with a generic invalid_request and no schema detail", async () => {
    harness = await createHarness();
    for (const body of ["not json", JSON.stringify({ app: "docs" }), JSON.stringify({ app: "docs", input: { kind: "files.list", dir: "", extra: 1 } }),
      JSON.stringify({ app: "docs", input: { kind: "files.read", path: "../etc/passwd" } }),
      JSON.stringify({ app: "docs", input: { kind: "files.read", path: "/etc/passwd" } })]) {
      const response = await harness.postRaw(body);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: { code: "invalid_request", message: APP_FILE_ERROR_MESSAGES.invalid_request } });
    }
  });

  it("refuses bodies above the route limit with too_large", async () => {
    harness = await createHarness();
    const response = await harness.postRaw(JSON.stringify({ app: "docs", input: { kind: "files.write", path: "a.bin", contentBase64: "A".repeat(MAX_APP_FILE_REQUEST_BYTES), ifVersion: null } }));
    expect(response.status).toBe(413);
    expect(await errorCode(response)).toBe("too_large");
  });

  it("rate limits each route instance and reports unavailable", async () => {
    harness = await createHarness();
    const statuses: number[] = [];
    for (let index = 0; index < 125; index++) statuses.push((await harness.post({ kind: "files.list", dir: "", limit: 1 })).status);
    expect(statuses.slice(0, 120).every((status) => status === 200)).toBe(true);
    expect(statuses.slice(120).every((status) => status === 503)).toBe(true);
  });

  it("caps requests in flight", async () => {
    harness = await createHarness();
    const responses = await Promise.all(Array.from({ length: 20 }, () => harness!.post({ kind: "files.list", dir: "" })));
    const statuses = responses.map((response) => response.status);
    expect(statuses.filter((status) => status === 200).length).toBeGreaterThanOrEqual(8);
    expect(statuses.every((status) => status === 200 || status === 503)).toBe(true);
  });
});

describe("gateway registration", () => {
  it("mounts the route at the contract path and authorizes with the request principal", async () => {
    harness = await createHarness();
    await writeFile(join(harness.home, "hello.txt"), "hello");
    const app = new Hono();
    let principal = "owner";
    app.use("*", async (context, next) => {
      context.set("authContextReady" as never, true as never);
      context.set("platformUserId" as never, principal as never);
      await next();
    });
    registerBridgeFileRoutes(app, { homePath: harness.home, env: { MATRIX_USER_ID: "owner", NODE_ENV: "production" } });
    const send = () => app.request(APP_FILES_BRIDGE_PATH, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ app: "docs", input: { kind: "files.stat", path: "hello.txt" } }),
    });
    const ok = await send();
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ path: "hello.txt", size: 5 });
    principal = "someone-else";
    expect((await send()).status).toBe(403);
  });

  it("denies every request when the gateway has no configured owner", async () => {
    harness = await createHarness();
    const app = new Hono();
    app.use("*", async (context, next) => { context.set("authContextReady" as never, true as never); await next(); });
    registerBridgeFileRoutes(app, { homePath: harness.home, env: { NODE_ENV: "production" } });
    const response = await app.request(APP_FILES_BRIDGE_PATH, {
      method: "POST", body: JSON.stringify({ app: "docs", input: { kind: "files.list", dir: "" } }),
    });
    expect(response.status).toBe(403);
  });
});
