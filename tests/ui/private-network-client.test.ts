import { describe, expect, it, vi } from "vitest";
import {
  createPrivateNetworkClient,
  PRIVATE_NETWORK_BASE_PATH,
  type PrivateNetworkTransport,
} from "../../packages/ui/src/private-network/client";
import {
  expiryLabel,
  isSafeLinkUrl,
  minutesLeft,
  onlineLabel,
  requestErrorStatus,
  shouldHidePanel,
} from "../../packages/ui/src/private-network/presentation";

function fakeTransport() {
  return {
    get: vi.fn(async () => ({})),
    post: vi.fn(async () => ({})),
    delete: vi.fn(async () => ({})),
  } satisfies PrivateNetworkTransport;
}

describe("createPrivateNetworkClient", () => {
  it("sends each operation to its gateway path with the expected body", async () => {
    const transport = fakeTransport();
    const client = createPrivateNetworkClient(transport);
    const signal = new AbortController().signal;
    await client.status(signal);
    await client.connect(signal);
    await client.disconnect(signal);
    await client.machines(signal);
    await client.createJoinCode(signal);
    await client.removeMachine("0123456789abcdef0123456789abcdef", 7, signal);
    expect(transport.get.mock.calls).toEqual([
      [PRIVATE_NETWORK_BASE_PATH, signal],
      [`${PRIVATE_NETWORK_BASE_PATH}/machines`, signal],
    ]);
    expect(transport.post.mock.calls).toEqual([
      [`${PRIVATE_NETWORK_BASE_PATH}/connect`, {}, signal],
      [`${PRIVATE_NETWORK_BASE_PATH}/disconnect`, { confirm: true }, signal],
      [`${PRIVATE_NETWORK_BASE_PATH}/join-codes`, {}, signal],
    ]);
    expect(transport.delete.mock.calls).toEqual([
      [`${PRIVATE_NETWORK_BASE_PATH}/machines/0123456789abcdef0123456789abcdef`, { revision: 7 }, signal],
    ]);
  });

  it.each(["../etc", "0123456789ABCDEF0123456789ABCDEF", "abc", "0123456789abcdef0123456789abcdef/x"])(
    "rejects invalid machine id %s without calling the gateway",
    async (id) => {
      const transport = fakeTransport();
      const client = createPrivateNetworkClient(transport);
      await expect(client.removeMachine(id, 1, new AbortController().signal)).rejects.toThrow();
      expect(transport.delete).not.toHaveBeenCalled();
    },
  );
});

describe("private network presentation helpers", () => {
  it("rounds remaining join-code minutes up and never goes negative", () => {
    const now = Date.parse("2026-11-21T10:00:00Z");
    expect(minutesLeft("2026-11-21T10:09:01Z", now)).toBe(10);
    expect(minutesLeft("2026-11-21T10:00:00Z", now)).toBe(0);
    expect(minutesLeft("2026-11-21T09:00:00Z", now)).toBe(0);
    expect(minutesLeft("not a date", now)).toBe(0);
    expect(expiryLabel("2026-11-21T10:05:00Z", now)).toBe("Expires in 5 min");
    expect(expiryLabel("2026-11-21T10:00:30Z", now)).toBe("Expires in 1 min");
    expect(expiryLabel("2026-11-21T09:59:00Z", now)).toBe("Expired");
  });

  it("hides the panel for managed computers and older gateways", () => {
    const base = { accessMode: null, loginUrl: null, tailnet: null, machine: null, viaPrivateNetwork: false };
    expect(shouldHidePanel({ ...base, supported: false, state: "logged-out" })).toBe(true);
    expect(shouldHidePanel({ ...base, supported: true, state: "unsupported" })).toBe(true);
    expect(shouldHidePanel({ ...base, supported: true, state: "connected" })).toBe(false);
  });

  it("reads HTTP status from shell and desktop error shapes", () => {
    expect(requestErrorStatus(Object.assign(new Error("x"), { status: 404 }))).toBe(404);
    expect(requestErrorStatus(Object.assign(new Error("x"), { httpStatus: 404 }))).toBe(404);
    expect(requestErrorStatus(new Error("x"))).toBeUndefined();
    expect(requestErrorStatus("404")).toBeUndefined();
  });

  it("only links http(s) URLs and labels unknown online state", () => {
    expect(isSafeLinkUrl("https://login.tailscale.com/a/abc")).toBe(true);
    expect(isSafeLinkUrl("javascript:alert(1)")).toBe(false);
    expect(isSafeLinkUrl("not a url")).toBe(false);
    expect(onlineLabel(true)).toBe("Online");
    expect(onlineLabel(false)).toBe("Offline");
    expect(onlineLabel(null)).toBe("Status unknown");
  });
});
