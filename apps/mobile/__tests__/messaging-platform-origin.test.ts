import * as SecureStore from "expo-secure-store";

const PRODUCTION = "https://app.matrix-os.com";
const CONFIGURED = "https://messaging-stage.example.com";
const originalOrigin = process.env.EXPO_PUBLIC_MATRIX_APP_URL;
const originalFetch = global.fetch;

function loadConfigured(origin?: string) {
  jest.resetModules();
  if (origin === undefined) delete process.env.EXPO_PUBLIC_MATRIX_APP_URL;
  else process.env.EXPO_PUBLIC_MATRIX_APP_URL = origin;
  return require("../lib/storage") as typeof import("../lib/storage");
}

afterEach(() => {
  if (originalOrigin === undefined) delete process.env.EXPO_PUBLIC_MATRIX_APP_URL;
  else process.env.EXPO_PUBLIC_MATRIX_APP_URL = originalOrigin;
  global.fetch = originalFetch;
  jest.resetModules();
  jest.restoreAllMocks();
});

it("uses the configured authority for authenticated computer inventory", async () => {
  loadConfigured(CONFIGURED);
  const fetcher = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ items: [], selectedSlot: null, hasMore: false, limit: 20 }) });
  global.fetch = fetcher;
  const { fetchComputers } = require("../lib/requests/computers") as typeof import("../lib/requests/computers");
  await fetchComputers("synthetic-owner-token");
  expect(fetcher).toHaveBeenCalledWith(CONFIGURED + "/api/auth/computers", expect.objectContaining({
    headers: expect.objectContaining({ Authorization: "Bearer synthetic-owner-token" }),
  }));
});

it.each(["", "http://attacker.example", "https://stage.example/path", "https://user@stage.example", "https://stage.example?token=bad"])(
  "rejects invalid explicit config before storage or authenticated requests: %s", (origin) => {
    const fetcher = jest.fn(); global.fetch = fetcher;
    expect(() => loadConfigured(origin)).toThrow("Matrix platform configuration unavailable.");
    expect(fetcher).not.toHaveBeenCalled();
  });

it("preserves explicit Native development loopback but rejects HTTP in production mode", () => {
  const runtime = global as typeof global & { __DEV__: boolean };
  jest.replaceProperty(runtime, "__DEV__", true);
  expect(loadConfigured("http://localhost:3000").HOSTED_GATEWAY_URL).toBe("http://localhost:3000");
  jest.replaceProperty(runtime, "__DEV__", false);
  expect(() => loadConfigured("http://localhost:3000")).toThrow("Matrix platform configuration unavailable.");
});

it("preserves the production default and existing connection key when no origin is configured", async () => {
  const storage = loadConfigured();
  const secure = require("expo-secure-store") as typeof SecureStore;
  jest.mocked(secure.getItemAsync).mockResolvedValue(null);
  expect(storage.HOSTED_GATEWAY_URL).toBe(PRODUCTION);
  expect((await storage.getSelectedGatewayConnection()).url).toBe(PRODUCTION);
  expect(secure.getItemAsync).toHaveBeenCalledWith("matrix_os_gateway_connection");
});

it("sends the authenticated Settings request only to the configured platform", async () => {
  loadConfigured(CONFIGURED);
  const fetcher = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ connected: false, admission: "public" }) });
  global.fetch = fetcher;
  const { fetchWhatsAppSettings } = require("../lib/requests/messaging") as typeof import("../lib/requests/messaging");
  await fetchWhatsAppSettings("synthetic-owner-token");
  expect(fetcher).toHaveBeenCalledWith(CONFIGURED + "/api/whatsapp/settings", expect.objectContaining({
    headers: expect.objectContaining({ Authorization: "Bearer synthetic-owner-token" }),
  }));
});

it("does not read the production saved gateway in a configured nonproduction build", async () => {
  const storage = loadConfigured(CONFIGURED);
  const secure = require("expo-secure-store") as typeof SecureStore;
  jest.mocked(secure.getItemAsync).mockImplementation(async (key) => key === "matrix_os_gateway_connection"
    ? JSON.stringify({ id: "production-selected", url: PRODUCTION + "/vm/owner", name: "Production", addedAt: 1 }) : null);
  expect((await storage.getSelectedGatewayConnection()).url).toBe(CONFIGURED);
  expect(secure.getItemAsync).not.toHaveBeenCalledWith("matrix_os_gateway_connection");
});

it("saves configured computer selection without writing the production key", async () => {
  const storage = loadConfigured(CONFIGURED);
  const secure = require("expo-secure-store") as typeof SecureStore;
  jest.mocked(secure.setItemAsync).mockClear();
  await storage.saveSelectedHostedComputer({ handle: "pr-919", runtimeSlot: "pr-919", label: "Preview Computer",
    availability: "available", kind: "preview", versionLabel: "v2026.07.12",
    gatewayPath: "/vm/pr-919?runtime=pr-919", capabilities: ["matrixComputerInventoryV1"] });
  expect(secure.setItemAsync).toHaveBeenCalledTimes(1);
  const [key, raw] = jest.mocked(secure.setItemAsync).mock.calls[0]!;
  expect(key).not.toBe("matrix_os_gateway_connection");
  expect(JSON.parse(raw).url).toBe(CONFIGURED + "/vm/pr-919?runtime=pr-919");
});

it("classifies configured hosted computer WebSockets at the platform root", () => {
  loadConfigured(CONFIGURED);
  const { GatewayClient } = require("../lib/gateway-client") as typeof import("../lib/gateway-client");
  const client = new GatewayClient(CONFIGURED + "/vm/pr-919?runtime=pr-919");
  expect(client.wsUrl).toBe("wss://messaging-stage.example.com/ws?runtime=pr-919");
  expect(client.terminalWsUrl).toBe("wss://messaging-stage.example.com/ws/terminal/tab?runtime=pr-919");
  const custom = new GatewayClient("https://custom.example.com/vm/pr-919?runtime=pr-919");
  expect(custom.wsUrl).toBe("wss://custom.example.com/vm/pr-919/ws?runtime=pr-919");
});

it("does not restore or remove production query-cache slots in a configured build", async () => {
  loadConfigured(CONFIGURED);
  const asyncStorage = require("@react-native-async-storage/async-storage");
  asyncStorage.getItem.mockClear();
  asyncStorage.getItem.mockResolvedValue(null);
  asyncStorage.removeItem.mockClear();
  const { mobileQueryPersistence } = require("../lib/query-cache-persistence");
  await mobileQueryPersistence.restore();
  await mobileQueryPersistence.setOwner(null);
  expect(asyncStorage.getItem).toHaveBeenCalled();
  expect(asyncStorage.getItem.mock.calls.every(([key]: [string]) => !/^matrix_os_query_cache_v1:[a-z-]+$/.test(key))).toBe(true);
  expect(asyncStorage.removeItem.mock.calls.every(([key]: [string]) => !/^matrix_os_query_cache_v1:[a-z-]+$/.test(key))).toBe(true);
});

it("does not restore or delete the production ready-journey hint in a configured build", async () => {
  loadConfigured(CONFIGURED);
  const asyncStorage = require("@react-native-async-storage/async-storage");
  asyncStorage.getItem.mockReset();
  asyncStorage.getItem.mockImplementation(async (key: string) => key === "matrix_os_journey_ready_v1"
    ? JSON.stringify({ userId: "synthetic-owner", savedAt: Date.now() }) : null);
  asyncStorage.removeItem.mockClear();
  const journey = require("../lib/journey-cache") as typeof import("../lib/journey-cache");
  expect(await journey.wasJourneyConnectable("synthetic-owner")).toBe(false);
  await journey.forgetJourneyConnectable();
  expect(asyncStorage.getItem).not.toHaveBeenCalledWith("matrix_os_journey_ready_v1");
  expect(asyncStorage.removeItem).not.toHaveBeenCalledWith("matrix_os_journey_ready_v1");
});

it("does not load or evict production collaboration drafts for the same owner and Chat", async () => {
  loadConfigured(CONFIGURED);
  const { loadCollaborationDraft, saveCollaborationDraft } = require("../lib/collaboration-drafts") as typeof import("../lib/collaboration-drafts");
  const productionKey = "matrix:collaboration:draft:v1:owner:scope:chat_stage";
  const data = new Map([[productionKey, "Production draft"]]);
  const storage = { getItem: jest.fn(async (key: string) => data.get(key) ?? null),
    setItem: jest.fn(async (key: string, value: string) => { data.set(key, value); }),
    removeItem: jest.fn(async (key: string) => { data.delete(key); }) };
  const identity = { actorId: "owner", scopeId: "scope", chatId: "chat_stage" };
  expect(await loadCollaborationDraft(storage, identity)).toBe("");
  await saveCollaborationDraft(storage, { ...identity, text: "Stage draft" });
  expect(data.get(productionKey)).toBe("Production draft");
  expect(storage.setItem).not.toHaveBeenCalledWith("matrix:collaboration:draft-index:v1", expect.anything());
});
