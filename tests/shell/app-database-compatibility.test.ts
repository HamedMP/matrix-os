import { createContext, runInContext } from "node:vm";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { buildBridgeScript } from "../../shell/src/lib/os-bridge.js";
import { prepareAppBridgeFetch, readAppBridgeResponse } from "../../shell/src/components/app-capability-request.js";
import { appDataChangeMessageForIdentity } from "../../shell/src/components/app-viewer-helpers.js";
import { buildMobileAppBridgeScript, createMobileAppCapabilityBroker } from "../../apps/mobile/lib/app-capability-bridge.js";
import { BridgeQueryBodySchema } from "../../packages/gateway/src/app-db-contracts.js";
import { createAppCapabilityRoutes } from "../../packages/gateway/src/app-capabilities/routes.js";

function webScript(app: string, request: (message: any, reply: (value: unknown) => void) => void) {
  const listeners: Record<string, (event: any) => void> = {};
  class Channel {
    port1: any = { close() {}, onmessage: null };
    port2 = { close() {}, reply: (data: unknown) => this.port1.onmessage({ data }) };
  }
  const context = createContext({ MessageChannel: Channel, setTimeout, clearTimeout, console,
    document: { documentElement: { dataset: {} }, createElement: () => ({}), head: { appendChild() {} } },
    window: { addEventListener(name: string, callback: (event: any) => void) { listeners[name] = callback; },
      parent: { postMessage(message: any, _target: any, ports: any[]) { request(message, ports[0].reply); } } },
  });
  runInContext(buildBridgeScript(app), context);
  return { context, listeners };
}

describe("database bridge compatibility", () => {
  it.each([0, 1])("cancels excessive %i-byte web response chunks before the8193rd chunk can accumulate", async (chunkSize) => {
    const cancel = vi.fn(); let count = 0;
    const response = new Response(new ReadableStream<Uint8Array>({ pull(controller) {
      if (++count <= 8193) controller.enqueue(chunkSize ? new Uint8Array([32]) : new Uint8Array());
      else { controller.enqueue(new TextEncoder().encode("{}")); controller.close(); }
    }, cancel }, { highWaterMark: 0 }));
    const bound = prepareAppBridgeFetch("notes", "/api/bridge/query", { method: "POST", body: JSON.stringify({ action: "find", table: "notes" }) });
    await expect(readAppBridgeResponse(response, bound)).rejects.toThrow("App response unavailable");
    expect(cancel).toHaveBeenCalledOnce();
    expect(count).toBe(8193);
  });

  it.each([0, 1])("cancels excessive %i-byte native response chunks without delivering a partial result", async (chunkSize) => {
    const runtime = "https://app.matrix-os.com/apps/notes/?session=fixture";
    const cancel = vi.fn(); const reply = vi.fn(); let count = 0;
    const request = async () => new Response(new ReadableStream<Uint8Array>({ pull(controller) {
      if (++count <= 8193) controller.enqueue(chunkSize ? new Uint8Array([32]) : new Uint8Array());
      else { controller.enqueue(new TextEncoder().encode("{}")); controller.close(); }
    }, cancel }, { highWaterMark: 0 }));
    const broker = createMobileAppCapabilityBroker({ app: "notes", runtimeUrl: runtime, launchId: "launch", request, reply });
    await broker.receive(JSON.stringify({ type: "matrix:app-ready", launchId: "launch", documentId: "doc" }), runtime);
    await broker.receive(JSON.stringify({ type: "matrix:app-request", launchId: "launch", documentId: "doc", id: 1, kind: "db", input: { action: "find", table: "notes" } }), runtime);
    expect(cancel).toHaveBeenCalledOnce();
    expect(count).toBe(8193);
    expect(reply.mock.calls[0][0]).toContain('"ok":false');
    broker.dispose();
  });

  it("saves a100KiB note and valid batch through the actual web script and stamped host request", async () => {
    const bodies: unknown[] = [];
    const { context } = webScript("notes", (message, reply) => {
      const bound = prepareAppBridgeFetch("notes", message.payload.url, message.payload.init);
      bodies.push(BridgeQueryBodySchema.parse(JSON.parse(bound.init.body as string)));
      reply({ ok: true, body: { id: "saved" } });
    });
    context.note = "x".repeat(100 * 1024);
    await expect(runInContext('window.MatrixOS.db.insert("notes", {text:note})', context)).resolves.toEqual({ id: "saved" });
    await runInContext('window.MatrixOS.db.bulkInsert("notes", [{text:note},{text:note}])', context);
    expect(bodies).toEqual([
      { app: "notes", action: "insert", table: "notes", data: { text: context.note } },
      { app: "notes", action: "bulkInsert", table: "notes", rows: [{ text: context.note }, { text: context.note }] },
    ]);
  });

  it("rejects oversized UTF8 database requests in the web page and trusted host without widening integration input", async () => {
    const request = vi.fn((_message, reply) => reply({ ok: true, body: {} }));
    const { context } = webScript("notes", request);
    context.note = "漢".repeat(334_000);
    await expect(runInContext('window.MatrixOS.db.insert("notes", {text:note})', context)).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
    expect(() => prepareAppBridgeFetch("notes", "/api/bridge/query", { method: "POST", body: JSON.stringify({ action: "insert", table: "notes", data: { text: context.note } }) })).toThrow();
    expect(() => prepareAppBridgeFetch("notes", "/api/bridge/capabilities", { method: "POST", body: JSON.stringify({ kind: "integrations.call", service: "google_drive", action: "list_files", params: { text: "x".repeat(100 * 1024) } }) })).toThrow();
  });

  it("saves100KiB from the native page and rejects direct oversized DB frames before network work", async () => {
    const runtime = "https://app.matrix-os.com/apps/notes/?session=fixture";
    let context: ReturnType<typeof createContext>;
    const request = vi.fn(async (_path: string, init: RequestInit) => {
      const query = BridgeQueryBodySchema.parse(JSON.parse(init.body as string));
      expect(query).toEqual({ app: "notes", action: "insert", table: "notes", data: { text: "x".repeat(100 * 1024) } });
      return Response.json({ id: "saved" });
    });
    const broker = createMobileAppCapabilityBroker({ app: "notes", runtimeUrl: runtime, launchId: "launch", request, reply: script => runInContext(script, context) });
    context = createContext({ setTimeout, clearTimeout, console, note: "x".repeat(100 * 1024), window: { top: null, addEventListener() {}, ReactNativeWebView: { postMessage(data: string) { void broker.receive(data, runtime); } } } });
    runInContext(buildMobileAppBridgeScript("notes", "launch"), context);
    await expect(runInContext('window.MatrixOS.db.insert("notes", {text:note})', context)).resolves.toEqual({ id: "saved" });
    await broker.receive(JSON.stringify({ type: "matrix:app-ready", launchId: "launch", documentId: "doc" }), runtime);
    await broker.receive(JSON.stringify({ type: "matrix:app-request", launchId: "launch", documentId: "doc", id: 2, kind: "db", input: { action: "insert", table: "notes", data: { text: "漢".repeat(334_000) } } }), runtime);
    expect(request).toHaveBeenCalledOnce();
    broker.dispose();
  });

  it("reaches a nested subscribed callback with the gateway's sanitized event and ignores other leaf apps", () => {
    const identity = "games/chess";
    const { context, listeners } = webScript(identity, () => {});
    context.changes = [];
    runInContext('window.MatrixOS.db.onChange("scores", function(event){changes.push(event.table);})', context);
    const forward = (changedApp: string) => {
      const message = appDataChangeMessageForIdentity(identity, changedApp, "scores");
      if (message) listeners.message({ data: message });
    };
    forward("chess");
    forward("privatechess");
    forward("gameschess");
    expect(context.changes).toEqual(["scores"]);
  });

  it("binds an arbitrary nested installed identity to its explicitly verified catalog runtime without borrowing leaf data", async () => {
    const runtime = "https://app.matrix-os.com/apps/timer/?session=fixture";
    const home = await mkdtemp(join(tmpdir(), "native-catalog-pair-"));
    await mkdir(join(home, "system"));
    await writeFile(join(home, "system/app-capabilities.json"), JSON.stringify({ apps: {
      "tools/timer": { services: { google_drive: ["list_files"] } },
    } }));
    const capabilities = createAppCapabilityRoutes({ homePath: home, ownerIds: ["owner"], resolveOwner: () => "owner", aiAllowed: async () => false,
      integrations: { inventory: vi.fn(async () => [{ service: "google_drive", label: "Granted", connectionId: "fixture" }]), describe: vi.fn(), call: vi.fn() } });
    const saved = new Map([["toolstimer", [{ elapsed: 5 }]], ["timer", [{ elapsed: 99 }]]]);
    const requests: Array<{ path: string; app: string }> = [];
    const request = async (path: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      requests.push({ path, app: body.app });
      if (path === "/api/bridge/query") {
        const query = BridgeQueryBodySchema.parse(body);
        return Response.json(saved.get(query.app));
      }
      return capabilities.request("/", init);
    };
    let context: ReturnType<typeof createContext>;
    const broker = createMobileAppCapabilityBroker({ app: "tools/timer", runtimeSlug: "timer", runtimeUrl: runtime, launchId: "launch", request, reply: script => runInContext(script, context) });
    try {
      context = createContext({ setTimeout, clearTimeout, console, window: { top: null, addEventListener() {}, ReactNativeWebView: { postMessage(data: string) { void broker.receive(data, runtime); } } } });
      runInContext(buildMobileAppBridgeScript("tools/timer", "launch"), context);
      expect(await runInContext('window.MatrixOS.db.find("timers")', context)).toEqual([{ elapsed: 5 }]);
      expect(await runInContext('window.MatrixOS.integrations()', context)).toEqual([{ service: "google_drive", account_label: "Granted", status: "active" }]);
      expect(requests).toEqual([{ path: "/api/bridge/query", app: "tools/timer" }, { path: "/api/bridge/capabilities", app: "tools/timer" }]);
      const denied = await capabilities.request("/", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ app: "timer", input: { kind: "integrations.list" } }) });
      expect(denied.status).toBe(403);
      expect(() => createMobileAppCapabilityBroker({ app: "tools/timer", runtimeSlug: "notes", runtimeUrl: runtime, launchId: "launch", request: vi.fn(), reply() {} })).toThrow();
      expect(() => createMobileAppCapabilityBroker({ app: "tools/timer", runtimeUrl: runtime, launchId: "launch", request: vi.fn(), reply() {} })).toThrow();
    } finally { broker.dispose(); await rm(home, { recursive: true, force: true }); }
  });
});
