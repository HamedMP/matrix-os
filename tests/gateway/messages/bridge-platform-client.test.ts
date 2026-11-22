import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BridgePlatformError,
  createMessagingBridgePlatformClient,
} from "../../../packages/gateway/src/messages/bridge-platform-client.js";

const machineToken = "a".repeat(64);
const handle = "alice";
const session = {
  homeserverUrl: "https://bridge.example.test",
  userId: "@mx_0123abcd:bridge.example.test",
  accessToken: "syt_secret_access_token_value",
  deviceId: "MATRIXOSGW",
  networks: ["whatsapp", "telegram"],
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function client(fetchImpl: typeof fetch) {
  return createMessagingBridgePlatformClient({
    platformUrl: "http://platform:9000",
    machineToken,
    handle,
    fetchImpl,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("messaging bridge platform client", () => {
  it("authenticates with the machine token and handle and parses the session with the contract schema", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, session));

    await expect(client(fetchImpl).createSession()).resolves.toEqual(session);

    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://platform:9000/internal/messaging-bridge/session");
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("error");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${machineToken}`);
    expect(headers.get("x-matrix-handle")).toBe(handle);
  });

  it("rejects a session whose homeserver is not https", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { ...session, homeserverUrl: "http://bridge.example.test" }));

    await expect(client(fetchImpl).createSession()).rejects.toMatchObject({ code: "unavailable" });
  });

  it("maps platform error envelopes onto typed failures without echoing the body", async () => {
    const cases: Array<[number, unknown, string]> = [
      [403, { error: { code: "not_enabled", message: "Not enabled" } }, "not_enabled"],
      [503, { error: { code: "misconfigured", message: "Messaging is not configured" } }, "misconfigured"],
      [404, { error: { code: "not_found", message: "Not found" } }, "not_found"],
      [500, { stack: "provider exploded at /srv/bridge" }, "unavailable"],
      [502, "not json", "unavailable"],
    ];
    for (const [status, body, code] of cases) {
      const fetchImpl = vi.fn(async () => typeof body === "string"
        ? new Response(body, { status })
        : jsonResponse(status, body));
      const error = await client(fetchImpl).listLogins("whatsapp").catch((err: unknown) => err);
      expect(error).toBeInstanceOf(BridgePlatformError);
      expect((error as BridgePlatformError).code).toBe(code);
      expect((error as Error).message).not.toMatch(/srv|provider|stack/);
    }
  });

  it("routes login calls per network and gives login start 40 s, waiting steps 35 s and input steps 10 s", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    const progress = {
      loginProcessId: "proc_1",
      step: { type: "display_and_wait", stepId: "fi.mau.whatsapp.qr", display: { kind: "qr", data: "2@abc" } },
    };
    const fetchImpl = vi.fn(async () => jsonResponse(200, progress));
    const platform = client(fetchImpl);

    await expect(platform.startLogin("whatsapp", { flowId: "qr" })).resolves.toEqual(progress);
    await platform.submitLoginStep("whatsapp", { loginProcessId: "proc_1", stepId: "fi.mau.whatsapp.qr" }, { longPoll: true });

    const urls = fetchImpl.mock.calls.map((call) => (call as unknown as [string])[0]);
    expect(urls).toEqual([
      "http://platform:9000/internal/messaging-bridge/whatsapp/login/start",
      "http://platform:9000/internal/messaging-bridge/whatsapp/login/step",
    ]);
    const bodies = fetchImpl.mock.calls.map((call) => JSON.parse(String((call as unknown as [string, RequestInit])[1].body)));
    expect(bodies).toEqual([{ flowId: "qr" }, { loginProcessId: "proc_1", stepId: "fi.mau.whatsapp.qr" }]);
    await platform.submitLoginStep("whatsapp", { loginProcessId: "proc_1", stepId: "code", fields: { code: "1" } }, { longPoll: false });
    expect(timeoutSpy.mock.calls.map((call) => call[0])).toEqual([40_000, 35_000, 10_000]);
  });

  it("cancels a login process and requires an ok acknowledgement", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { ok: true }));
    await client(fetchImpl).cancelLogin("linkedin", { loginProcessId: "proc_9" });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://platform:9000/internal/messaging-bridge/linkedin/login/cancel");
    expect(JSON.parse(String(init.body))).toEqual({ loginProcessId: "proc_9" });

    const malformed = vi.fn(async () => jsonResponse(200, { ok: "yes" }));
    await expect(client(malformed).cancelLogin("linkedin", { loginProcessId: "proc_9" })).rejects.toMatchObject({ code: "unavailable" });
  });

  it("refuses an unknown network before any request is made", async () => {
    const fetchImpl = vi.fn();
    await expect(client(fetchImpl as unknown as typeof fetch).listLoginFlows("signal" as never)).rejects.toMatchObject({ code: "invalid_request" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("treats a transport failure as unavailable", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed: connect ECONNREFUSED 10.0.0.1");
    });
    const error = await client(fetchImpl).logout("telegram", { loginId: "login_1" }).catch((err: unknown) => err);
    expect(error).toMatchObject({ code: "unavailable" });
    expect((error as Error).message).not.toContain("10.0.0.1");
  });

  it("refuses to construct with an unsafe platform URL or a bad handle", () => {
    expect(() => createMessagingBridgePlatformClient({ platformUrl: "ftp://platform", machineToken, handle })).toThrow();
    expect(() => createMessagingBridgePlatformClient({ platformUrl: "https://user:pw@platform", machineToken, handle })).toThrow();
    expect(() => createMessagingBridgePlatformClient({ platformUrl: "https://platform", machineToken, handle: "../x" })).toThrow();
  });
});
