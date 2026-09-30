import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { authMiddleware } from "../../packages/gateway/src/auth.js";
import { requireRequestPrincipal } from "../../packages/gateway/src/request-principal.js";
import { buildPlatformVerificationToken } from "../../packages/platform/src/platform-token.js";
import { buildPlatformWebSocketUpgradeHeaders, buildPlatformUserProof } from "../../packages/platform/src/session-routing-websocket.js";

const HANDLE = "pr-2055";
const OWNER = "user_fixtureowner";
const SECRET = "separate-preview-platform-signing-secret";
const PREVIEW_TOKEN = buildPlatformVerificationToken(HANDLE, SECRET);
const ORIGINAL_TOKEN = "a".repeat(64);
let requestCount = 0;

function headers(actor = OWNER, bearer = PREVIEW_TOKEN) {
  return {
    authorization: `Bearer ${bearer}`,
    "x-platform-user-id": actor,
    "x-platform-verified": buildPlatformUserProof(HANDLE, actor, SECRET),
    "x-real-ip": `198.18.0.${++requestCount}`,
  };
}
function app() {
  const instance = new Hono();
  instance.use("*", authMiddleware(ORIGINAL_TOKEN));
  instance.get("/api/system/info", c => c.json(requireRequestPrincipal(c, {
    configuredUserId: OWNER, isTrustedSingleUserGateway: true, authEnabled: true,
    isProduction: true, isLocalDevelopment: false, devDefaultUserId: "local",
    requireAuthContextReady: true,
  })));
  instance.get("/ws", c => c.json(requireRequestPrincipal(c, {
    configuredUserId: OWNER, isTrustedSingleUserGateway: true, authEnabled: true,
    isProduction: true, isLocalDevelopment: false, devDefaultUserId: "local",
  })));
  return instance;
}

beforeEach(() => {
  vi.stubEnv("MATRIX_PREVIEW_RUNTIME", "true");
  vi.stubEnv("MATRIX_PREVIEW_OWNER_CONTROL", "true");
  vi.stubEnv("MATRIX_HANDLE", HANDLE);
  vi.stubEnv("MATRIX_RUNTIME_SLOT", HANDLE);
  vi.stubEnv("MATRIX_CLERK_USER_ID", OWNER);
  vi.stubEnv("MATRIX_USER_ID", OWNER);
  vi.stubEnv("UPGRADE_TOKEN", PREVIEW_TOKEN);
  vi.stubEnv("PLATFORM_JWT_SECRET", "");
  vi.stubEnv("PLATFORM_JWT_PUBLIC_KEY", "");
});
afterEach(() => vi.unstubAllEnvs());

describe("explicit preview owner control binding", () => {
  it("accepts the preview platform's real signed owner headers without rotating the original credential", async () => {
    const instance = app();
    const response = await instance.request("/api/system/info", { headers: headers() });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ userId: OWNER, source: "platform-verified" });
    const original = await instance.request("/api/system/info", { headers: { authorization: `Bearer ${ORIGINAL_TOKEN}` } });
    expect(original.status).toBe(200);
  });
  it("accepts the same signed owner after platform WebSocket token termination", async () => {
    const upgrade = buildPlatformWebSocketUpgradeHeaders({
      incomingHeaders: { authorization: "Bearer untrusted", "x-platform-user-id": "user_outsider",
        "x-platform-verified": "0".repeat(64) },
      externalHost: "preview.example.test", handle: HANDLE, userId: OWNER,
      platformSecret: SECRET, includePlatformProof: true, isCodeDomain: false,
    });
    const signedHeaders = Object.fromEntries(upgrade.split("\r\n").map(line => {
      const colon = line.indexOf(":");
      return [line.slice(0, colon), line.slice(colon + 1).trim()];
    }));
    const response = await app().request("/ws", { headers: signedHeaders });
    expect(response.status).toBe(200);
    expect((await response.json()).userId).toBe(OWNER);
  });
  it.each([
    ["disabled owner binding", "MATRIX_PREVIEW_OWNER_CONTROL", ""],
    ["ordinary customer runtime", "MATRIX_PREVIEW_RUNTIME", "false"],
    ["customer handle", "MATRIX_HANDLE", "customer"],
    ["primary runtime slot", "MATRIX_RUNTIME_SLOT", "primary"],
    ["another preview slot", "MATRIX_RUNTIME_SLOT", "pr-2056"],
    ["missing owner", "MATRIX_CLERK_USER_ID", ""],
    ["conflicting configured owner", "MATRIX_USER_ID", "user_anotherowner"],
    ["malformed owner", "MATRIX_CLERK_USER_ID", "../owner"],
    ["short binding token", "UPGRADE_TOKEN", "short"],
  ])("rejects %s", async (_label, key, value) => {
    vi.stubEnv(key, value);
    expect((await app().request("/api/system/info", { headers: headers() })).status).toBe(401);
  });
  it.each(["user_member", "user_outsider", "user_guest"])("rejects a valid signed proof for %s", async actor => {
    expect((await app().request("/api/system/info", { headers: headers(actor) })).status).toBe(401);
  });
  it("requires both owner proof and bearer; query-only credentials do not authenticate", async () => {
    const instance = app();
    for (const missing of ["authorization", "x-platform-user-id", "x-platform-verified"] as const) {
      const values: Record<string, string> = headers();
      delete values[missing];
      expect((await instance.request("/api/system/info", { headers: values })).status).toBe(401);
    }
    expect((await instance.request(`/ws?token=${PREVIEW_TOKEN}`, { headers: { "x-real-ip": "198.18.1.1" } })).status).toBe(401);
    expect((await instance.request(`/api/system/info?token=${PREVIEW_TOKEN}`)).status).toBe(401);
  });
  it("rejects forged proofs and tokens signed for another runtime", async () => {
    const forged = headers();
    forged["x-platform-verified"] = "0".repeat(64);
    expect((await app().request("/api/system/info", { headers: forged })).status).toBe(401);
    expect((await app().request("/api/system/info", { headers: headers(OWNER, buildPlatformVerificationToken("pr-2056", SECRET)) })).status).toBe(401);
  });
});
