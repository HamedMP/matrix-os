import { describe, expect, it, vi } from "vitest";
import { createBoundedPipedreamGet } from "../../packages/gateway/src/integrations/pipedream-bounded-get.js";

function fixture(response: () => Response = () => Response.json({ emailAddress: "me@example.test" })) {
  const fetcher = vi.fn(async (_url: string, _init: RequestInit) => response());
  const get = createBoundedPipedreamGet({ projectId: "proj_fixture", environment: "production",
    getAccessToken: async () => "synthetic-token", fetcher });
  return { get, fetcher };
}
const identity = { externalUserId: "owner_fixture", accountId: "apn_fixture" };

describe("bounded Jev Pipedream transport", () => {
  it("pins the existing owner/account/environment and the fixed Gmail profile target", async () => {
    const { get, fetcher } = fixture();
    expect(await get({ ...identity, kind: "profile" })).toEqual({ emailAddress: "me@example.test" });
    const [raw, init] = fetcher.mock.calls[0]!;
    const url = new URL(raw);
    expect(url.origin).toBe("https://api.pipedream.com");
    expect(url.searchParams.get("external_user_id")).toBe(identity.externalUserId);
    expect(url.searchParams.get("account_id")).toBe(identity.accountId);
    const encoded = url.pathname.split("/").at(-1)!;
    expect(Buffer.from(encoded, "base64url").toString()).toBe("https://gmail.googleapis.com/gmail/v1/users/me/profile");
    expect(init.method).toBe("GET");
    expect(init.redirect).toBe("error");
    expect(new Headers(init.headers).get("x-pd-environment")).toBe("production");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
  it("fixes discovery to one Inbox page and never accepts a caller URL or page token", async () => {
    const { get, fetcher } = fixture();
    await get({ ...identity, kind: "threads" });
    const target = new URL(Buffer.from(new URL(fetcher.mock.calls[0]![0]).pathname.split("/").at(-1)!, "base64url").toString());
    expect(target.pathname).toBe("/gmail/v1/users/me/threads");
    expect(target.searchParams.get("maxResults")).toBe("30");
    expect(target.searchParams.get("labelIds")).toBe("INBOX");
    expect(target.searchParams.has("pageToken")).toBe(false);
    await expect(get({ ...identity, kind: "threads", url: "https://attacker.example/", pageToken: "forged" })).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each(["declared", "streamed", "malformed", "status", "invalid-utf8"] as const)("rejects %s upstream data before parsing it as evidence", async (mode) => {
    const cancelled = vi.fn();
    const { get, fetcher } = fixture(() => {
      if (mode === "declared") return new Response(new ReadableStream({ cancel: cancelled }), { headers: { "content-length": "999999" } });
      if (mode === "streamed") return new Response(new ReadableStream({ start(controller) {
        controller.enqueue(new Uint8Array(20_000)); controller.enqueue(new Uint8Array(20_000));
      }, cancel: cancelled }));
      if (mode === "malformed") return new Response("{no");
      if (mode === "invalid-utf8") return new Response(new Uint8Array([0xc3, 0x28]));
      return new Response(new ReadableStream({ cancel: cancelled }), { status: 503 });
    });
    await expect(get({ ...identity, kind: "profile" })).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
    if (["declared", "streamed", "status"].includes(mode)) expect(cancelled).toHaveBeenCalled();
  });
  it.each(["write", "wrong-id", "missing-account"] as const)("rejects %s without requesting OAuth or provider data", async (mode) => {
    const getAccessToken = vi.fn(async () => "synthetic-token");
    const fetcher = vi.fn();
    const get = createBoundedPipedreamGet({ projectId: "proj_fixture", environment: "production", getAccessToken, fetcher });
    const input = mode === "write" ? { ...identity, kind: "send" }
      : mode === "wrong-id" ? { ...identity, kind: "message", id: "../other?format=raw" }
        : { ...identity, accountId: "", kind: "profile" };
    await expect(get(input)).rejects.toThrow();
    expect(getAccessToken).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("honors a cancelled run before OAuth or mailbox access", async () => {
    const getAccessToken = vi.fn(async () => "synthetic-token");
    const fetcher = vi.fn();
    const get = createBoundedPipedreamGet({ projectId: "proj_fixture", environment: "production", getAccessToken, fetcher });
    await expect(get({ ...identity, kind: "profile" }, AbortSignal.abort())).rejects.toThrow();
    expect(getAccessToken).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("times out an unfinished streamed body and cancels it without retry", async () => {
    vi.useFakeTimers();
    try {
      const cancelled = vi.fn();
      const { get, fetcher } = fixture(() => new Response(new ReadableStream({ start(controller) {
        controller.enqueue(new TextEncoder().encode("{"));
      }, cancel: cancelled })));
      const pending = expect(get({ ...identity, kind: "profile" })).rejects.toThrow();
      await vi.advanceTimersByTimeAsync(10_001);
      await pending;
      expect(cancelled).toHaveBeenCalledTimes(1);
      expect(fetcher).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });
});
