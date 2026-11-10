import { describe, expect, it, vi } from "vitest";
import { installTerminalWindowAuth, resolveRuntimeTarget } from "@desktop/main/terminal-window/gateway-auth";

const GATEWAY = "https://app.matrix-os.com";

describe("resolveRuntimeTarget", () => {
  it("reads the computer from the runtime query, defaulting to the primary computer", () => {
    expect(resolveRuntimeTarget(`${GATEWAY}/api/terminal/workspaces?runtime=review`, GATEWAY)).toBe("review");
    expect(resolveRuntimeTarget(`${GATEWAY}/api/terminal/workspaces`, GATEWAY)).toBe("primary");
    expect(resolveRuntimeTarget("wss://app.matrix-os.com/ws/terminal/tab?workspaceId=a&runtime=review", GATEWAY)).toBe("review");
    expect(resolveRuntimeTarget(`${GATEWAY}/vm/pr-42/api/mcp-servers`, GATEWAY)).toBe("pr-42");
    expect(resolveRuntimeTarget(`${GATEWAY}/vm/pr-42/api/mcp-servers?runtime=pr-42`, GATEWAY)).toBe("pr-42");
  });

  it("gives no target when the path and the query name different computers, or the path names no known one", () => {
    // A request routed by its path must never carry the bearer its query asked for.
    expect(resolveRuntimeTarget(`${GATEWAY}/vm/pr-42/api/x?runtime=review`, GATEWAY)).toBeNull();
    expect(resolveRuntimeTarget(`${GATEWAY}/vm/pr-42/api/x?runtime=primary`, GATEWAY)).toBeNull();
    expect(resolveRuntimeTarget(`${GATEWAY}/vm/someone/api/x`, GATEWAY)).toBeNull();
    expect(resolveRuntimeTarget(`${GATEWAY}/vm`, GATEWAY)).toBeNull();
    expect(resolveRuntimeTarget(`${GATEWAY}/vm/pr-0/api/x`, GATEWAY)).toBeNull();
  });

  it("fails closed for other origins, malformed or ambiguous targets", () => {
    expect(resolveRuntimeTarget("https://evil.example/api?runtime=review", GATEWAY)).toBeNull();
    expect(resolveRuntimeTarget("https://app.matrix-os.com.evil.example/api", GATEWAY)).toBeNull();
    expect(resolveRuntimeTarget("http://app.matrix-os.com/api", GATEWAY)).toBeNull();
    expect(resolveRuntimeTarget(`${GATEWAY}/api?runtime=review&runtime=primary`, GATEWAY)).toBeNull();
    expect(resolveRuntimeTarget(`${GATEWAY}/api?runtime=../x`, GATEWAY)).toBeNull();
    expect(resolveRuntimeTarget(`${GATEWAY}/api?runtime=`, GATEWAY)).toBeNull();
    expect(resolveRuntimeTarget("not a url", GATEWAY)).toBeNull();
    expect(resolveRuntimeTarget(`${GATEWAY}/api`, null)).toBeNull();
  });
});

type Sent = { requestHeaders?: Record<string, string>; cancel?: boolean };

function setup(tokens: Record<string, string | "unavailable">) {
  type BeforeSend = (details: { url: string; requestHeaders: Record<string, string> }, callback: (response: Sent) => void) => void;
  type Completed = (details: { url: string; statusCode: number }) => void;
  let beforeSend!: BeforeSend;
  let completed!: Completed;
  const session = { webRequest: {
    onBeforeSendHeaders: (listener: BeforeSend) => { beforeSend = listener; },
    onCompleted: (listener: Completed) => { completed = listener; },
  } };
  const broker = {
    credential: vi.fn(async (slot: string) => {
      const found = tokens[slot];
      if (found === undefined) return { token: null, reason: "denied" as const };
      return found === "unavailable" ? { token: null, reason: "unavailable" as const } : { token: found };
    }),
    unauthorized: vi.fn(),
    confirmed: vi.fn(),
  };
  const installed = installTerminalWindowAuth(session, { broker, getGatewayOrigin: () => GATEWAY });
  const sendRaw = (url: string, requestHeaders: Record<string, string> = {}) =>
    new Promise<Sent>((resolve) => beforeSend({ url, requestHeaders }, resolve));
  const send = async (url: string, requestHeaders: Record<string, string> = {}) => (await sendRaw(url, requestHeaders)).requestHeaders ?? {};
  return { broker, installed, send, sendRaw, complete: (url: string, statusCode: number) => completed({ url, statusCode }) };
}

describe("Terminal window gateway authentication", () => {
  it("attaches the bearer of the computer the request targets", async () => {
    const { send } = setup({ primary: "primary-token", review: "review-token" });
    expect((await send(`${GATEWAY}/api/terminal/workspaces?runtime=review`)).Authorization).toBe("Bearer review-token");
    expect((await send(`${GATEWAY}/api/terminal/workspaces`)).Authorization).toBe("Bearer primary-token");
  });

  it("attaches no bearer and removes a renderer-supplied one when the target is unknown or foreign", async () => {
    const { broker, send } = setup({ primary: "primary-token" });
    const spoofed = { Authorization: "Bearer renderer-supplied", authorization: "Bearer lower" };
    for (const url of [
      `${GATEWAY}/api/terminal/workspaces?runtime=not-mine`,
      `${GATEWAY}/api?runtime=review&runtime=primary`,
    ]) {
      const headers = await send(url, { ...spoofed });
      expect(headers.Authorization).toBeUndefined();
      expect(headers.authorization).toBeUndefined();
    }
    const foreign = await send("https://evil.example/collect?runtime=primary", {});
    expect(foreign.Authorization).toBeUndefined();
    expect(broker.credential).not.toHaveBeenCalledWith(expect.stringContaining("evil"));
    expect(broker.credential).toHaveBeenCalledTimes(1);
  });

  it("fails the request, instead of sending it bare, when a bearer cannot be fetched right now", async () => {
    // Sent without a bearer it would earn a 401 and tell the owner to sign in again.
    const { broker, sendRaw } = setup({ review: "unavailable" });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(await sendRaw(`${GATEWAY}/api/x?runtime=review`, { Authorization: "Bearer renderer-supplied" })).toEqual({ cancel: true });
    broker.credential.mockRejectedValueOnce(new Error("boom"));
    expect(await sendRaw(`${GATEWAY}/api/x?runtime=review`)).toEqual({ cancel: true });
  });

  it("reports 401s and successes for the token it attached", async () => {
    const { broker, send, complete } = setup({ review: "review-token" });
    const url = `${GATEWAY}/api/terminal/workspaces?runtime=review`;
    await send(url);
    complete(url, 401);
    expect(broker.unauthorized).toHaveBeenCalledWith("review", "review-token");
    await send(url);
    complete(url, 200);
    expect(broker.confirmed).toHaveBeenCalledWith("review");
    complete("https://evil.example/x?runtime=review", 401);
    expect(broker.unauthorized).toHaveBeenCalledTimes(1);
  });

  it("counts an accepted terminal WebSocket as success and forgets attached bearers on sign-out", async () => {
    const { broker, installed, send, complete } = setup({ review: "review-token" });
    const socket = "wss://app.matrix-os.com/ws/terminal/tab?runtime=review";
    await send(socket);
    complete(socket, 101);
    expect(broker.confirmed).toHaveBeenCalledWith("review");
    installed.clear();
    complete(socket, 401);
    expect(broker.unauthorized).not.toHaveBeenCalled();
  });
});
