import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { APP_AI_CHANNEL, APP_AI_ROUTES_CHANNEL, APP_CAPABILITY_CHANNEL, MAX_APP_DATABASE_REPLY_BYTES, appRuntimeSlugFromIdentity } from "@matrix-os/contracts";
import { NATIVE_APP_QUERY_CHANNEL } from "@desktop/shared/native-app-bridge";
import { NativeAppBridge, createNativeAppAiRequester, createNativeAppQueryRequester } from "@desktop/main/embeds/native-app-bridge";
import { createNativeAppAiRoutesRequester, createNativeAppCapabilityRequester } from "@desktop/main/embeds/native-app-capabilities";
import { createAppCapabilityRoutes } from "../../packages/gateway/src/app-capabilities/routes.js";

const temporaryHomes: string[] = [];
afterEach(async () => { await Promise.all(temporaryHomes.splice(0).map(home => rm(home, { recursive: true, force: true }))); });

it("preserves independent nested identities through IPC, HTTP and exact integration grants", async () => {
  const home = await mkdtemp(join(tmpdir(), "electron-app-identity-")); temporaryHomes.push(home);
  await mkdir(join(home, "system"));
  await writeFile(join(home, "system/app-capabilities.json"), JSON.stringify({ apps: {
    "games/chess": { services: { google_drive: ["list_files"] } },
  } }));
  const integrations = { inventory: vi.fn(async () => [{ service: "google_drive", label: "Personal", connectionId: "drive-1" }]), describe: vi.fn(), call: vi.fn() };
  const capabilities = createAppCapabilityRoutes({ homePath: home, ownerIds: ["owner"], resolveOwner: () => "owner", integrations, aiAllowed: async app => app === "games/chess" });
  const observed: Array<{ path: string; app: string }> = [];
  const fetchFn: typeof fetch = async (rawUrl, init) => {
    const url = new URL(String(rawUrl));
    const app = init?.body ? JSON.parse(String(init.body)).app : url.searchParams.get("app");
    observed.push({ path: url.pathname, app });
    if (url.pathname === "/api/bridge/capabilities") return capabilities.request("/", init);
    if (url.pathname === "/api/bridge/query") return Response.json([{ app }]);
    if (url.pathname === "/api/bridge/ai/routes") return Response.json({ routes: [], defaultRoute: null });
    if (url.pathname === "/api/bridge/ai") return Response.json({ text: app });
    throw new Error("Unexpected request");
  };
  const options = { getGatewayOrigin: () => "https://gateway.test", getToken: () => "synthetic-owner-token", fetchFn };
  const bridge = new NativeAppBridge({ authGeneration: () => 0, gatewayOrigin: options.getGatewayOrigin, generate: vi.fn(), gatewayRequest: vi.fn(), request: createNativeAppQueryRequester(options), aiRequest: createNativeAppAiRequester(options), capabilityRequest: createNativeAppCapabilityRequester(options), aiRoutesRequest: createNativeAppAiRoutesRequester(options) });
  const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
  bridge.registerIpc({ handle: (channel, handler) => handlers.set(channel, handler as never) });
  for (const [index, app] of ["games/chess", "chess", "private/chess"].entries()) {
    const route = appRuntimeSlugFromIdentity(app);
    expect(route).toBe(app === "games/chess" ? "chess" : app);
    bridge.register(index + 1, app, route);
    const frame = {};
    const event = { senderFrame: frame, sender: { id: index + 1, mainFrame: frame, getURL: () => `https://gateway.test/apps/${route}/`, isDestroyed: () => false } };
    await expect(handlers.get(NATIVE_APP_QUERY_CHANNEL)!(event, { action: "find", table: "notes" })).resolves.toEqual([{ app }]);
    await expect(handlers.get(APP_AI_CHANNEL)!(event, { prompt: "text" })).resolves.toEqual({ text: app });
    await expect(handlers.get(APP_AI_ROUTES_CHANNEL)!(event, {})).resolves.toEqual({ routes: [], defaultRoute: null });
    await expect(handlers.get(APP_CAPABILITY_CHANNEL)!(event, { kind: "capabilities" })).resolves.toEqual({ version: 1, integrations: app === "games/chess", ai: app === "games/chess" });
    const inventory = handlers.get(APP_CAPABILITY_CHANNEL)!(event, { kind: "integrations.list" });
    if (app === "games/chess") await expect(inventory).resolves.toEqual({ services: [{ service: "google_drive", account_label: "Personal", status: "active" }] });
    else await expect(inventory).rejects.toThrow("App integrations are unavailable");
    const before = observed.length;
    await expect(handlers.get(APP_CAPABILITY_CHANNEL)!(event, { kind: "capabilities", app: "games/chess" })).rejects.toThrow();
    await expect(handlers.get(NATIVE_APP_QUERY_CHANNEL)!(event, { action: "find", table: "notes", app: "games/chess" })).rejects.toThrow();
    expect(observed).toHaveLength(before);
    expect(observed.filter(row => row.app === app).map(row => row.path)).toEqual(["/api/bridge/query", "/api/bridge/ai", "/api/bridge/ai/routes", "/api/bridge/capabilities", "/api/bridge/capabilities"]);
  }
  expect(integrations.inventory).toHaveBeenCalledTimes(1);
});

it("preserves database replies above ordinary capability limits and bounds actual streamed bytes", async () => {
  const rows = Array.from({ length: 100 }, (_, index) => ({ id: String(index), content: "x".repeat(3 * 1024) }));
  const fetchFn = vi.fn<typeof fetch>(async () => Response.json(rows));
  const request = createNativeAppQueryRequester({ getGatewayOrigin: () => "https://gateway.test", getToken: () => "synthetic", fetchFn });
  await expect(request("games/chess", { action: "find", table: "notes" })).resolves.toEqual(rows);
  const cancel = vi.fn();
  fetchFn.mockImplementation(async () => new Response(new ReadableStream<Uint8Array>({ pull(controller) { controller.enqueue(new Uint8Array(MAX_APP_DATABASE_REPLY_BYTES + 1)); }, cancel }, { highWaterMark: 0 })));
  await expect(request("games/chess", { action: "find", table: "notes" })).rejects.toThrow("database response too large");
  expect(cancel).toHaveBeenCalledOnce();
});
