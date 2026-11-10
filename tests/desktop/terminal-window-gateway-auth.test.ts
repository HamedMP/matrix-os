import { describe, expect, it, vi } from "vitest";
import { installTerminalWindowAuth, resolveRuntimeTarget } from "@desktop/main/terminal-window/gateway-auth";

const GATEWAY = "https://app.matrix-os.com";

describe("resolveRuntimeTarget", () => {
  it("reads the computer from the runtime query, defaulting to the primary computer", () => {
    expect(resolveRuntimeTarget(`${GATEWAY}/api/terminal/workspaces?runtime=review`, GATEWAY)).toBe("review");
    expect(resolveRuntimeTarget(`${GATEWAY}/api/terminal/workspaces`, GATEWAY)).toBe("primary");
    expect(resolveRuntimeTarget("wss://app.matrix-os.com/ws/terminal/tab?workspaceId=a&runtime=review", GATEWAY)).toBe("review");
    expect(resolveRuntimeTarget(`${GATEWAY}/vm/pr-42/api/mcp-servers`, GATEWAY)).toBe("pr-42");
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

function setup(tokens: Record<string, string | null>) {
  type BeforeSend = (details: { url: string; requestHeaders: Record<string, string> },
    callback: (response: { requestHeaders: Record<string, string> }) => void) => void;
  type Completed = (details: { url: string; statusCode: number }) => void;
  let beforeSend!: BeforeSend;
  let completed!: Completed;
  const session = { webRequest: {
    onBeforeSendHeaders: (listener: BeforeSend) => { beforeSend = listener; },
    onCompleted: (listener: Completed) => { completed = listener; },
  } };
  const broker = {
    token: vi.fn(async (slot: string) => tokens[slot] ?? null),
    unauthorized: vi.fn(),
    confirmed: vi.fn(),
  };
  installTerminalWindowAuth(session, { broker, getGatewayOrigin: () => GATEWAY });
  const send = (url: string, requestHeaders: Record<string, string> = {}) =>
    new Promise<Record<string, string>>((resolve) => beforeSend({ url, requestHeaders }, (response) => resolve(response.requestHeaders)));
  return { broker, send, complete: (url: string, statusCode: number) => completed({ url, statusCode }) };
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
    expect(broker.token).not.toHaveBeenCalledWith(expect.stringContaining("evil"));
    expect(broker.token).toHaveBeenCalledTimes(1);
  });

  it("still completes the request when the broker throws", async () => {
    const { broker, send } = setup({});
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    broker.token.mockRejectedValueOnce(new Error("boom"));
    expect((await send(`${GATEWAY}/api/x?runtime=review`)).Authorization).toBeUndefined();
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
});
