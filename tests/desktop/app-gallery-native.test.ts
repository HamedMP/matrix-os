import { describe, expect, it, vi } from "vitest";
import { NativeAppBridge, createNativeAppGatewayRequester, createNativeAppQueryRequester } from "@desktop/main/embeds/native-app-bridge";
import { createNativeAppDatabase, NativeAppQuerySchema } from "@desktop/shared/native-app-bridge";
import { createNativeAppGatewayFetch } from "@desktop/shared/native-app-gateway";
import { persistRecord, archiveRecord, RecordConflictError } from "../../home/app-templates/connected-starter/src/persistence";
import { importPrompt } from "../../home/app-templates/connected-starter/src/import";
import type { Database, Definition, OwnerRecord } from "../../home/app-templates/connected-starter/src/types";
import { loadGallery, installGalleryApp } from "../../home/apps/app-gallery/src/model";
import catalog from "../../home/system/app-gallery.json";

const origin = "https://gateway.test";
const sender = { id: 71, url: `${origin}/apps/app-gallery/` };
function fixture(fetchFn = vi.fn<typeof fetch>(async () => new Response("{}"))) {
  let generation = 1;
  const options = { getGatewayOrigin: () => origin, getToken: () => "owner-token", fetchFn };
  const generate = vi.fn();
  const bridge = new NativeAppBridge({ authGeneration: () => generation, gatewayOrigin: () => origin,
    generate: generate, aiRequest: vi.fn(), request: createNativeAppQueryRequester(options),
    gatewayRequest: createNativeAppGatewayRequester(options) });
  bridge.register(sender.id, "app-gallery");
  return { bridge, fetchFn, generate, changeOwner: () => generation++ };
}

describe("Electron Desktop gallery", () => {
  it("loads the catalog and installs a starter through exact owner-authenticated capabilities", async () => {
    const fetchFn = vi.fn<typeof fetch>(async (url) => {
      const path = new URL(String(url)).pathname;
      const value = path === "/api/app-gallery" ? { version: 1, apps: catalog.apps.map((app) => ({ ...app, installed: false })) }
        : path === "/api/bridge/service" ? { services: [{ service: "gmail", account_label: "personal", status: "active" }] }
        : { status: "installed", slug: "folio", name: "Folio", path: "apps/folio" };
      return new Response(JSON.stringify(value));
    });
    const { bridge } = fixture(fetchFn);
    const gatewayFetch = createNativeAppGatewayFetch((request) => bridge.gatewayFetch(sender, request));
    const integrations = async () => ((await gatewayFetch<{ services: unknown[] }>("/api/bridge/service")).services);
    const loaded = await loadGallery({ gatewayFetch, integrations });
    expect(loaded.apps).toHaveLength(24);
    expect(loaded.connections?.[0]?.account_label).toBe("personal");
    await expect(installGalleryApp({ gatewayFetch }, "folio")).resolves.toMatchObject({ status: "installed", slug: "folio" });
    expect(fetchFn).toHaveBeenLastCalledWith(`${origin}/api/app-gallery/folio/install`, expect.objectContaining({
      method: "POST", redirect: "error", headers: { authorization: "Bearer owner-token", "content-type": "application/json" }, body: "{}", signal: expect.any(AbortSignal),
    }));
  });

  it("allows starter inventory only, while denying forged senders, wrong apps and retired owner registrations", async () => {
    const { bridge, fetchFn, changeOwner } = fixture();
    bridge.register(72, "folio");
    await bridge.gatewayFetch({ id: 72, url: `${origin}/apps/folio/` }, { url: "/api/bridge/service" });
    await expect(bridge.gatewayFetch({ id: 72, url: `${origin}/apps/folio/` }, { url: "/api/app-gallery" })).rejects.toThrow();
    bridge.register(73, "notes-other");
    bridge.register(74, "custom/app-gallery", "app-gallery");
    for (const source of [{ ...sender, id: 99 }, { ...sender, id: 74 }, { id: 73, url: `${origin}/apps/notes-other/` }, { ...sender, url: "https://evil.test/apps/app-gallery/" }, { ...sender, url: `${origin}/apps/folio/` }])
      await expect(bridge.gatewayFetch(source, { url: "/api/app-gallery" })).rejects.toThrow();
    changeOwner();
    await expect(bridge.gatewayFetch(sender, { url: "/api/app-gallery" })).rejects.toThrow();
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it.each([
    { url: "/api/app-gallery?x=1" }, { url: "/api/../api/app-gallery" }, { url: "/api/app-gallery/%66olio/install", init: { method: "POST", body: "{}" } },
    { url: "/api/bridge/service", init: { method: "POST", body: "{}" } }, { url: "/api/app-gallery/folio/install" },
    { url: "/api/app-gallery/folio/install", init: { method: "POST", body: '{"code":"forged"}' } },
    { url: "/api/app-gallery/folio/install", init: { method: "POST", body: "{}", headers: { authorization: "forged" } } },
    { url: "https://evil.test/api/app-gallery" }, { url: "/api/bridge/ai" }, { url: "/api/apps" },
  ])("rejects unrelated routes and malformed installation requests: %j", async (request) => {
    const { bridge, fetchFn } = fixture();
    await expect(bridge.gatewayFetch(sender, request)).rejects.toThrow();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("checks the actual main-frame sender at gallery and CAS IPC boundaries", async () => {
    const { bridge, fetchFn } = fixture();
    const handle = vi.fn(); bridge.registerIpc({ handle });
    const frame = {};
    const event = { senderFrame: {}, sender: { id: sender.id, mainFrame: frame, getURL: () => sender.url } };
    const gateway = handle.mock.calls.find(([channel]) => channel === "native-app:gateway-fetch")![1];
    const query = handle.mock.calls.find(([channel]) => channel === "native-app:query")![1];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await expect(gateway(event, { url: "/api/app-gallery" })).rejects.toThrow();
      await expect(query(event, { action: "compareAndSwap", table: "records", id: "one", expectedPayload: {}, data: { payload: {} } })).rejects.toThrow();
      expect(fetchFn).not.toHaveBeenCalled();
    } finally { warn.mockRestore(); }
  });

  it("sends the exact selected-account read-only import through the existing kernel dispatcher", () => {
    const { bridge, generate } = fixture();
    bridge.register(72, "folio");
    const prompt = importPrompt(catalog.apps[0] as Definition, { accounts: [{ service: "gmail", label: "personal" }], start: "2026-01-01", end: "2026-10-06", context: "" }, [{ service: "gmail", account_label: "personal", status: "active" }]);
    expect(prompt).toContain('"account_label":"personal"');
    expect(prompt).toContain("read-only");
    bridge.generate({ id: 72, url: `${origin}/apps/folio/` }, prompt);
    expect(generate).toHaveBeenCalledWith("folio", prompt);
  });
});

describe("native bridge to starter persistence", () => {
  it("validates exact bounded CAS snapshots and rejects malformed successful responses", async () => {
    const request = { action: "compareAndSwap", table: "records", id: "one", expectedPayload: {}, data: { payload: {} } };
    expect(NativeAppQuerySchema.safeParse(request).success).toBe(true);
    for (const expectedPayload of [null, [], "old", { undefinedValue: undefined }, { content: "x".repeat(300000) }])
      expect(NativeAppQuerySchema.safeParse({ ...request, expectedPayload }).success).toBe(false);
    const { bridge } = fixture(vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ ok: "false" }))));
    bridge.register(72, "folio");
    await expect(bridge.query({ id: 72, url: `${origin}/apps/folio/` }, request)).rejects.toThrow("invalid database response");
  });

  it("preserves success/conflict results and emits data changes only for successful CAS writes", async () => {
    let ok = true;
    const fetchFn = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ ok })));
    const { bridge } = fixture(fetchFn); bridge.register(72, "folio");
    const db = createNativeAppDatabase((request) => bridge.query({ id: 72, url: `${origin}/apps/folio/` }, request));
    const changed = vi.fn(); db.onChange("records", changed);
    const original: OwnerRecord = { id: "one", rowId: "one", fields: { title: "Old" }, scope: "personal", accounts: [], sources: [], manualFields: [], updatedAt: "2026-01-01", basePayload: { id: "one", fields: { title: "Old" } } };
    const database = db as unknown as Database;
    const saved = await persistRecord(database, { ...original, fields: { title: "Changed" } });
    expect(saved.fields.title).toBe("Changed");
    expect(JSON.parse(fetchFn.mock.calls[0]![1]!.body as string)).toMatchObject({ app: "folio", action: "compareAndSwap", expectedPayload: original.basePayload });
    expect(changed).toHaveBeenCalledTimes(1);
    ok = false;
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await expect(persistRecord(database, original)).rejects.toBeInstanceOf(RecordConflictError);
      await expect(archiveRecord(database, original)).rejects.toBeInstanceOf(RecordConflictError);
      expect(changed).toHaveBeenCalledTimes(1);
      expect(original.archivedAt).toBeUndefined();
    } finally { error.mockRestore(); }
  });
});
