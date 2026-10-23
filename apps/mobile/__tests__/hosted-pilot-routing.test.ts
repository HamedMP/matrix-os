const pilot = "https://gmail-pilot.matrix-os.com";
const production = "https://app.matrix-os.com";
const originalTarget = process.env.EXPO_PUBLIC_MATRIX_HOSTED_ORIGIN;
const computer = { handle: "pilot-box", runtimeSlot: "primary", label: "Main Computer", availability: "available", kind: "customer", versionLabel: "v1.0.0", gatewayPath: "/vm/pilot-box", capabilities: ["matrixComputerInventoryV1"] };
let mockCache: Record<string, string> = {};
const mockApplication = { applicationId: "com.matrixos.mobile.gmailpilot" };
jest.mock("expo-application", () => ({ __esModule: true, get applicationId() { return mockApplication.applicationId; } }));
jest.mock("@react-native-async-storage/async-storage", () => ({
  __esModule: true,
  default: { getItem: jest.fn(async (key: string) => mockCache[key] ?? null),
    setItem: jest.fn(async (key: string, value: string) => { mockCache[key] = value; }),
    removeItem: jest.fn(async (key: string) => { delete mockCache[key]; }) },
}));

beforeEach(() => { jest.resetModules(); process.env.EXPO_PUBLIC_MATRIX_HOSTED_ORIGIN = pilot; mockApplication.applicationId = "com.matrixos.mobile.gmailpilot"; mockCache = {}; });
afterEach(() => {
  jest.restoreAllMocks();
  if (originalTarget === undefined) delete process.env.EXPO_PUBLIC_MATRIX_HOSTED_ORIGIN;
  else process.env.EXPO_PUBLIC_MATRIX_HOSTED_ORIGIN = originalTarget;
  jest.resetModules();
});
function response(value: unknown): Response { return { ok: true, json: async () => value } as Response; }

it("uses the pilot as hosted without granting hosted trust to arbitrary or inactive origins", () => {
  const storage = require("../lib/storage");
  expect(storage.HOSTED_GATEWAY_URL).toBe(pilot);
  expect(storage.isHostedGatewayUrl(`${pilot}/vm/pilot-box?runtime=review`)).toBe(true);
  for (const value of [production, "https://customer.invalid", `${pilot}.attacker.invalid`, `${pilot}/vm/pilot-box?runtime=review&token=secret`]) expect(storage.isHostedGatewayUrl(value)).toBe(false);
  expect(storage.getMobileJourneyGatewayUrl(`${pilot}/vm/pilot-box`)).toBe(pilot);
  expect(storage.resolveMobileAppSessionLaunchUrl(`${pilot}/vm/pilot-box`, "/apps/notes/?session=pilot-box.opaque")).toBe(`${pilot}/apps/notes/?session=pilot-box.opaque`);
});

it("discovers the active computer only at the trusted pilot origin with the current Clerk token", async () => {
  const secure = require("expo-secure-store");
  secure.getItemAsync.mockResolvedValue(null);
  const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue(response({ items: [computer], selectedSlot: "primary", hasMore: false, limit: 20 }));
  const { fetchActiveComputer } = require("../lib/requests/computers");
  expect(await fetchActiveComputer("current-clerk-fixture")).toEqual(computer);
  expect(fetchMock).toHaveBeenCalledWith(`${pilot}/api/auth/computers`, expect.objectContaining({ headers: { Authorization: "Bearer current-clerk-fixture" } }));
});

it("keeps HTTP and fresh WebSocket credentials on the pilot canonical origin", async () => {
  const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue(response({ token: "short-lived-ws-fixture", expiresAt: Date.now() + 60000 }));
  const { GatewayClient } = require("../lib/gateway-client");
  const getToken = jest.fn(async () => "current-clerk-fixture");
  const client = new GatewayClient(`${pilot}/vm/pilot-box?runtime=review`, getToken);
  expect(client.wsUrl).toBe("wss://gmail-pilot.matrix-os.com/ws?runtime=review");
  expect(client.terminalWsUrl).toBe("wss://gmail-pilot.matrix-os.com/ws/terminal/tab?runtime=review");
  await client.getWsToken();
  expect(getToken).toHaveBeenCalled();
  expect(fetchMock).toHaveBeenCalledWith(`${pilot}/api/auth/ws-token?runtime=review`, expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer current-clerk-fixture" }) }));
  await client.healthCheck();
  expect(fetchMock).toHaveBeenLastCalledWith(`${pilot}/vm/pilot-box/health?runtime=review`, expect.anything());
});

it("accepts only the selected build target Gmail launcher and leaves Pipedream available", async () => {
  const fetchMock = jest.spyOn(global, "fetch");
  const { createIntegrationConnectUrl } = require("../lib/requests/integrations");
  const state = "a".repeat(43);
  const accepted = `${pilot}/auth/gmail?state=${state}`;
  for (const url of [accepted, "https://pipedream.com/connect/fixture"]) {
    fetchMock.mockResolvedValueOnce(response({ url, service: "gmail" }));
    await expect(createIntegrationConnectUrl("clerk-fixture", `${pilot}/vm/pilot-box`, "gmail", { connectionMethod: "matrix" })).resolves.toBe(url);
  }
  for (const url of [`${production}/auth/gmail?state=${state}`, `${pilot}.evil.invalid/auth/gmail?state=${state}`, `${accepted}&redirect=evil`, `${pilot}/other?state=${state}`]) {
    fetchMock.mockResolvedValueOnce(response({ url, service: "gmail" }));
    await expect(createIntegrationConnectUrl("clerk-fixture", `${pilot}/vm/pilot-box`, "gmail")).rejects.toThrow("Could not start connection");
  }
});

it("never reads or overwrites production persisted gateway selection", async () => {
  const secure = require("expo-secure-store");
  secure.getItemAsync.mockImplementation(async (key: string) => key === "matrix_os_gateway_connection"
    ? JSON.stringify({ url: `${production}/vm/production-box`, runtimeSlot: "primary" }) : null);
  secure.setItemAsync.mockResolvedValue(undefined);
  const storage = require("../lib/storage");
  await expect(storage.getSelectedGatewayConnection()).resolves.toMatchObject({ url: pilot });
  expect(secure.getItemAsync).not.toHaveBeenCalledWith("matrix_os_gateway_connection");
  await storage.saveSelectedHostedComputer(computer);
  const [key, value] = secure.setItemAsync.mock.calls.at(-1);
  expect(key).toBe("matrix_os_gateway_connection.gmail-pilot");
  expect(JSON.parse(value).url).toBe(`${pilot}/vm/pilot-box`);
  expect(value).not.toContain("token");
});

it("does not restore an inactive Matrix target as a custom Clerk destination or accept Basic credentials for it", async () => {
  const secure = require("expo-secure-store");
  secure.getItemAsync.mockResolvedValue(JSON.stringify({ url: production, id: "matrix-os-custom" }));
  const storage = require("../lib/storage");
  await expect(storage.getSelectedGatewayConnection()).resolves.toMatchObject({ url: pilot });
  await expect(storage.saveSelectedGatewayUrl(production)).rejects.toThrow("Use this app’s Matrix OS Cloud target");
  await expect(storage.saveSelectedGatewayBasicAuth(production, "owner", "fixture-password")).rejects.toThrow("Use this app’s Matrix OS Cloud target");
});

it("does not restore or clear production query snapshots belonging to the same Clerk user", async () => {
  const productionSlot = "matrix_os_query_cache_v1:active-computer";
  mockCache[productionSlot] = JSON.stringify({ userId: "user_fixture", queryKey: ["mobile", "computers", "active", "user_fixture"], updatedAt: Date.now(), data: { ...computer, handle: "production-box", gatewayPath: "/vm/production-box" } });
  const { mobileQueryPersistence } = require("../lib/query-cache-persistence");
  const { mobileQueryClient } = require("../lib/query-client");
  try {
    await mobileQueryPersistence.restore();
    expect(mobileQueryClient.getQueryData(["mobile", "computers", "active", "user_fixture"])).toBeUndefined();
    await mobileQueryPersistence.setOwner(null);
    expect(mockCache[productionSlot]).toBeDefined();
    const cache = require("@react-native-async-storage/async-storage").default;
    expect(cache.getItem).toHaveBeenCalledWith(`${productionSlot}.gmail-pilot`);
    expect(cache.removeItem).not.toHaveBeenCalledWith(productionSlot);
  } finally { mobileQueryClient.clear(); }
});

it("keeps persisted journey readiness and sign-out cleanup separate from production", async () => {
  const key = "matrix_os_journey_ready_v1";
  mockCache[key] = JSON.stringify({ userId: "user_fixture", savedAt: Date.now() });
  const journey = require("../lib/journey-cache");
  expect(await journey.wasJourneyConnectable("user_fixture")).toBe(false);
  await journey.rememberJourneyConnectable("user_fixture");
  expect(mockCache[`${key}.gmail-pilot`]).toBeDefined();
  await journey.forgetJourneyConnectable(null);
  expect(mockCache[`${key}.gmail-pilot`]).toBeUndefined();
  expect(mockCache[key]).toBeDefined();
});

it("preserves the default production cache keys and ignores pilot snapshots", async () => {
  delete process.env.EXPO_PUBLIC_MATRIX_HOSTED_ORIGIN;
  mockApplication.applicationId = "com.matrixos.mobile";
  const key = "matrix_os_query_cache_v1:active-computer";
  const snapshot = (data: typeof computer) => JSON.stringify({ userId: "user_fixture", queryKey: ["mobile", "computers", "active", "user_fixture"], updatedAt: Date.now(), data });
  mockCache[key] = snapshot(computer);
  mockCache[`${key}.gmail-pilot`] = snapshot({ ...computer, handle: "other-pilot", gatewayPath: "/vm/other-pilot" });
  const { mobileQueryPersistence } = require("../lib/query-cache-persistence");
  const { mobileQueryClient } = require("../lib/query-client");
  try {
    await mobileQueryPersistence.restore();
    expect(mobileQueryClient.getQueryData(["mobile", "computers", "active", "user_fixture"])).toEqual(computer);
    await mobileQueryPersistence.setOwner(null);
    expect(mockCache[key]).toBeUndefined();
    expect(mockCache[`${key}.gmail-pilot`]).toBeDefined();
  } finally { mobileQueryClient.clear(); }
});
