const originalTarget = process.env.EXPO_PUBLIC_MATRIX_HOSTED_ORIGIN;
const mockNativeApplication: { applicationId: string | null } = { applicationId: "com.matrixos.mobile.gmailpilot" };
jest.mock("expo-application", () => ({ __esModule: true, get applicationId() { return mockNativeApplication.applicationId; } }));
const mockMakeRedirectUri = jest.fn(({ path }: { path: string }) => `https://browser.example.invalid/${path}`);
jest.mock("expo-auth-session", () => ({ makeRedirectUri: (options: { path: string }) => mockMakeRedirectUri(options) }));

const pilot = "https://gmail-pilot.matrix-os.com";
const mockFetch = jest.fn();
global.fetch = mockFetch;

beforeEach(() => {
  jest.resetModules();
  process.env.EXPO_PUBLIC_MATRIX_HOSTED_ORIGIN = pilot;
  mockNativeApplication.applicationId = "com.matrixos.mobile.gmailpilot";
  mockMakeRedirectUri.mockClear();
  mockFetch.mockReset().mockResolvedValue(new Response(JSON.stringify({ url: "https://pipedream.com/connect", service: "gmail" })));
});
afterEach(() => {
  if (originalTarget === undefined) delete process.env.EXPO_PUBLIC_MATRIX_HOSTED_ORIGIN;
  else process.env.EXPO_PUBLIC_MATRIX_HOSTED_ORIGIN = originalTarget;
});

it.each(["matrix", "pipedream"] as const)("uses the pilot return for %s Gmail", async connectionMethod => {
  const { createIntegrationConnectUrl } = require("../lib/requests/integrations");
  await createIntegrationConnectUrl("token", `${pilot}/vm/test`, "gmail", { connectionMethod });
  expect(JSON.parse(mockFetch.mock.calls[0][1].body).redirectUri).toBe("matrixos-gmail-pilot://integrations");
});

it.each(["matrix", "pipedream"] as const)("refuses the primary binary before %s Gmail sends", async connectionMethod => {
  mockNativeApplication.applicationId = "com.matrixos.mobile";
  const { createIntegrationConnectUrl } = require("../lib/requests/integrations");
  await expect(createIntegrationConnectUrl("token", `${pilot}/vm/test`, "gmail", { connectionMethod })).rejects.toThrow();
  expect(mockFetch).not.toHaveBeenCalled();
});

it("routes only this build's integration return to Settings", () => {
  const { connectAppsReturnPath, noteConnectAppsSignIn } = require("../lib/connect-apps-return");
  noteConnectAppsSignIn("settings");
  expect(connectAppsReturnPath("matrixos-gmail-pilot://integrations?status=success")).toBe("/settings-detail/connect-apps");
  expect(connectAppsReturnPath("matrixos://integrations")).toBe("matrixos://integrations");
});

it("checks actual native binary identity and rejects a primary SSO override", () => {
  const { mobileSsoRedirectUri } = require("../lib/native-callback-target");
  expect(mobileSsoRedirectUri()).toBe("matrixos-gmail-pilot://sso-callback");
  expect(() => mobileSsoRedirectUri("matrixos://sso-callback")).toThrow();
  expect(() => mobileSsoRedirectUri("https://untrusted.invalid")).toThrow();
  mockNativeApplication.applicationId = "com.matrixos.mobile";
  expect(() => mobileSsoRedirectUri()).toThrow();
});

it("retains production callbacks only for the production native binary", async () => {
  delete process.env.EXPO_PUBLIC_MATRIX_HOSTED_ORIGIN;
  mockNativeApplication.applicationId = "com.matrixos.mobile";
  const { mobileSsoRedirectUri } = require("../lib/native-callback-target");
  const { createIntegrationConnectUrl } = require("../lib/requests/integrations");
  expect(mobileSsoRedirectUri()).toBe("matrixos://sso-callback");
  await createIntegrationConnectUrl("token", "https://app.matrix-os.com/vm/test", "gmail");
  expect(JSON.parse(mockFetch.mock.calls[0][1].body).redirectUri).toBe("matrixos://integrations");
  mockNativeApplication.applicationId = "com.matrixos.mobile.gmailpilot";
  expect(() => mobileSsoRedirectUri()).toThrow();
  await expect(createIntegrationConnectUrl("token", "https://app.matrix-os.com/vm/test", "gmail")).rejects.toThrow();
  expect(mockFetch).toHaveBeenCalledTimes(1);
});

it("preserves Expo Web browser-origin SSO without pretending to have a native app ID", () => {
  const { Platform } = require("react-native");
  const platform = jest.replaceProperty(Platform, "OS", "web");
  mockNativeApplication.applicationId = null;
  try {
    const { mobileSsoRedirectUri } = require("../lib/native-callback-target");
    expect(mobileSsoRedirectUri()).toBe("https://browser.example.invalid/sso-callback");
    expect(mockMakeRedirectUri).toHaveBeenCalledWith({ scheme: "matrixos-gmail-pilot", path: "sso-callback" });
    expect(mobileSsoRedirectUri("https://configured.example.invalid/sso-callback")).toBe("https://configured.example.invalid/sso-callback");
  } finally { platform.restore(); }
});
