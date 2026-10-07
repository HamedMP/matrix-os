import { afterEach, describe, expect, it, vi } from "vitest";
import { CustomMcpOAuthManager } from "../../packages/gateway/src/integrations/custom-mcp/oauth.js";
import { decryptCustomMcpCredential, encryptCustomMcpCredential } from "../../packages/gateway/src/integrations/custom-mcp/crypto.js";
import type { CustomMcpCredential } from "../../packages/gateway/src/integrations/custom-mcp/broker.js";
import type { PlatformDb } from "../../packages/gateway/src/platform-db.js";

function fixture(initial?: NonNullable<CustomMcpCredential["oauth"]>) {
  const key = Buffer.alloc(32, 14);
  const binding = { userId: "owner", serverId: "server" };
  const now = new Date("2026-10-07T12:00:00Z");
  const row = { id: "server", user_id: "owner", revision: 2, auth_mode: "oauth", url: "https://public.example/mcp",
    encrypted_credentials: initial ? encryptCustomMcpCredential({ oauth: initial }, key, binding) : null };
  const db = {
    getCustomMcpServerForBroker: vi.fn(async () => ({ ...row })),
    updateCustomMcpCredentials: vi.fn(async (_id, _owner, revision, encrypted, _status, advance) => {
      if (revision !== row.revision) return false;
      row.encrypted_credentials = encrypted; if (advance) row.revision++; return true;
    }),
    updateCustomMcpCredentialsIfCurrent: vi.fn(async (_id, _owner, revision, expected, encrypted, _status, advance) => {
      if (revision !== row.revision || expected !== row.encrypted_credentials) return false;
      row.encrypted_credentials = encrypted; if (advance) row.revision++; return true;
    }),
  };
  const request = vi.fn(async ({ url }: { url: string }) => ({ status: 200, body: url.includes("oauth-protected-resource")
    ? { resource: row.url, authorization_servers: ["https://auth.example"] }
    : { authorization_endpoint: "https://auth.example/authorize", token_endpoint: "https://auth.example/token", revocation_endpoint: "https://auth.example/revoke", registration_endpoint: "https://auth.example/register" } }));
  const validateUrl = vi.fn(async (url: string) => ({ url: new URL(url), address: "93.184.216.34", family: 4 as const }));
  const manager = new CustomMcpOAuthManager({ db: db as unknown as PlatformDb, encryptionKey: key, clientId: "client",
    redirectUri: "https://matrix.example/callback", now: () => now, request, validateUrl });
  return { row, db, request, validateUrl, manager, now,
    credential: () => decryptCustomMcpCredential<CustomMcpCredential>(row.encrypted_credentials!, key, binding),
    setCredential: (oauth: NonNullable<CustomMcpCredential["oauth"]>) => { row.encrypted_credentials = encryptCustomMcpCredential({ oauth }, key, binding); } };
}

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
describe("OAuth reconnect start fencing", () => {
  it("does not overwrite a refresh token rotated during discovery at the same policy revision", async () => {
    const f = fixture({ refreshToken: "old-refresh" });
    const original = f.request.getMockImplementation()!;
    f.request.mockImplementationOnce(async input => { f.setCredential({ refreshToken: "rotated-refresh" }); return original(input); });
    await expect(f.manager.start("owner", "server")).rejects.toMatchObject({ code: "conflict" });
    expect(f.credential().oauth?.refreshToken).toBe("rotated-refresh");
    expect(f.row.revision).toBe(2);
  });
  it("defers reconnect before any discovery while an active refresh owns the grant", async () => {
    const f = fixture({ refreshToken: "old-refresh", refreshing: true, refreshStartedAt: "2026-10-07T11:59:59Z" });
    await expect(f.manager.start("owner", "server")).rejects.toMatchObject({ name: "CustomMcpRefreshPendingError" });
    expect(f.request).not.toHaveBeenCalled();
    expect(f.validateUrl).not.toHaveBeenCalled();
    expect(f.credential().oauth?.refreshing).toBe(true);
  });
  it("rejects a refresh claim acquired after the initial reconnect snapshot", async () => {
    const f = fixture({ refreshToken: "old-refresh" });
    const original = f.request.getMockImplementation()!;
    f.request.mockImplementationOnce(async input => {
      f.setCredential({ refreshToken: "old-refresh", refreshing: true, refreshStartedAt: f.now.toISOString() });
      return original(input);
    });
    await expect(f.manager.start("owner", "server")).rejects.toMatchObject({ code: "conflict" });
    expect(f.credential().oauth?.refreshing).toBe(true);
  });
  it.each([undefined, { refreshToken: "retained-refresh" }])("atomically saves a fresh reconnect state and advances revision once (%#)", async initial => {
    const f = fixture(initial);
    const url = new URL(await f.manager.start("owner", "server"));
    expect(f.row.revision).toBe(3);
    expect(f.credential().oauth?.state).toBe(url.searchParams.get("state"));
    expect(f.credential().oauth?.refreshToken).toBe(initial?.refreshToken);
    expect(f.db.updateCustomMcpCredentials).not.toHaveBeenCalled();
    expect(f.db.updateCustomMcpCredentialsIfCurrent).toHaveBeenCalledOnce();
  });
});

describe("OAuth full start deadline", () => {
  it.each(["https://public.example/mcp", "https://auth.example", "https://auth.example/", "https://auth.example/authorize",
    "https://auth.example/token", "https://auth.example/revoke", "https://auth.example/register"])("bounds stalled direct validation of %s", async stalled => {
    vi.useFakeTimers();
    vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => {
      const controller = new AbortController(); setTimeout(() => controller.abort(), ms); return controller.signal;
    });
    const f = fixture();
    const validate = f.validateUrl.getMockImplementation()!;
    f.validateUrl.mockImplementation(url => url === stalled ? new Promise(() => {}) : validate(url));
    let settled = false; let failure: unknown;
    void f.manager.start("owner", "server").then(() => { settled = true; }, error => { settled = true; failure = error; });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.validateUrl).toHaveBeenCalledWith(stalled);
    expect(settled).toBe(true);
    expect(failure).toBeInstanceOf(Error);
    expect(f.db.updateCustomMcpCredentials).not.toHaveBeenCalled();
    expect(f.db.updateCustomMcpCredentialsIfCurrent).not.toHaveBeenCalled();
  });
  it("bounds dynamic registration using the same start signal without saving partial state", async () => {
    vi.useFakeTimers();
    vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => {
      const controller = new AbortController(); setTimeout(() => controller.abort(), ms); return controller.signal;
    });
    const f = fixture();
    const original = f.request.getMockImplementation()!;
    f.request.mockImplementation(input => input.url.endsWith("/register") ? new Promise(() => {}) : original(input));
    const manager = new CustomMcpOAuthManager({ db: f.db as unknown as PlatformDb, encryptionKey: Buffer.alloc(32, 14),
      redirectUri: "https://matrix.example/callback", request: f.request, validateUrl: f.validateUrl });
    let settled = false;
    void manager.start("owner", "server").catch(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(settled).toBe(true);
    expect(f.request).toHaveBeenCalledTimes(3);
    const signals = f.request.mock.calls.map(call => (call[0] as { signal?: AbortSignal }).signal);
    expect(signals[0]).toBeInstanceOf(AbortSignal);
    expect(signals.every(signal => signal === signals[0])).toBe(true);
    expect(signals[0]?.aborted).toBe(true);
    expect(f.db.updateCustomMcpCredentialsIfCurrent).not.toHaveBeenCalled();
  });
  it("shares one absolute deadline across sequential metadata and direct DNS checks", async () => {
    vi.useFakeTimers();
    vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => {
      const controller = new AbortController(); setTimeout(() => controller.abort(), ms); return controller.signal;
    });
    const f = fixture();
    const original = f.request.getMockImplementation()!;
    f.request.mockImplementationOnce(input => new Promise(resolve => { setTimeout(() => { void original(input).then(resolve); }, 6_000); }));
    f.validateUrl.mockImplementationOnce(() => new Promise(() => {}));
    let settled = false;
    void f.manager.start("owner", "server").then(() => { settled = true; }, () => { settled = true; });
    await vi.advanceTimersByTimeAsync(9_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
    expect(f.request).toHaveBeenCalledOnce();
    expect(f.db.updateCustomMcpCredentialsIfCurrent).not.toHaveBeenCalled();
  });
});
