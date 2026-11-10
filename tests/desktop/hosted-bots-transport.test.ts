import { describe, expect, it, vi } from "vitest";
import { createHostedBotsProtocolHandler, hostedBotsIdentity, hostedBotsSocketAllowed, hostedBotsProviderLoginAllowed, HOSTED_BOTS_ORIGIN } from "@desktop/main/embeds/hosted-bots-transport";

const auth = { signedIn: true, platformHost: "https://app.matrix-os.com", userId: "owner", runtimeSlot: "pv-202-0123abcd" };
const cookieName = "omb_session_8799_abc";
const cookieValue = "omb_sess_" + "a".repeat(43);

function setup() {
  let currentAuth = auth;
  const get = vi.fn().mockResolvedValue([
    { name: cookieName, value: cookieValue, httpOnly: true, secure: true },
    { name: "__session", value: "other-credential" },
  ]);
  const set = vi.fn().mockResolvedValue(undefined);
  const remove = vi.fn().mockResolvedValue(undefined);
  const flushStore = vi.fn().mockResolvedValue(undefined);
  const fetcher = vi.fn<typeof fetch>();
  const identity = hostedBotsIdentity(auth)!;
  const handler = createHostedBotsProtocolHandler(identity, {
    getIdentity: () => hostedBotsIdentity(currentAuth),
    getToken: () => "matrix-bearer",
    cookies: { get, set, remove, flushStore },
    fetcher,
  });
  return { handler, fetcher, set, remove, get, flushStore, changeScope: () => { currentAuth = { ...auth, userId: "different" }; } };
}

describe("hosted Bots Electron transport", () => {
  it("derives a separate persistent partition for an authorized preview owner", () => {
    expect(hostedBotsIdentity({ ...auth, runtimeSlot: "primary" })).toBeNull();
    expect(hostedBotsIdentity({ ...auth, signedIn: false })).toBeNull();
    expect(hostedBotsIdentity({ ...auth, platformHost: "https://other.test/vm/anything" })).toBeNull();
    expect(hostedBotsIdentity(auth)?.partition).toMatch(/^hosted-bots-[a-f0-9]{32}$/);
    expect(hostedBotsIdentity({ ...auth, userId: "other" })?.partition).not.toBe(hostedBotsIdentity(auth)?.partition);
  });

  it("keeps Matrix bearer server-side, brokers only the upstream cookie and preserves native document framing policy", async () => {
    const { handler, fetcher, set, flushStore } = setup();
    fetcher.mockResolvedValue(new Response("page", { headers: {
      "content-security-policy": "frame-ancestors 'none'",
      "content-type": "text/html",
      "x-matrix-hosted-bots-set-session": cookieName + "=" + cookieValue + "; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=300",
    } }));
    const response = await handler(new Request(HOSTED_BOTS_ORIGIN + "/pair", { headers: {
      cookie: "__session=forged", authorization: "Bearer forged", accept: "text/html", origin: "https://spoof.test",
    } }));
    expect(await response.text()).toBe("page");
    expect(response.headers.get("content-security-policy")).toBe("frame-ancestors 'none'");
    expect(response.headers.has("set-cookie")).toBe(false);
    expect(response.headers.has("x-matrix-hosted-bots-set-session")).toBe(false);
    expect(set).toHaveBeenCalledWith(expect.objectContaining({
      url: HOSTED_BOTS_ORIGIN, name: cookieName, value: cookieValue, httpOnly: true, secure: true,
    }));
    expect(flushStore).toHaveBeenCalledOnce();
    const [target, request] = fetcher.mock.calls[0]!;
    expect(String(target)).toBe("https://app.matrix-os.com/vm/pv-202-0123abcd/api/hosted-bots/runtime/pair");
    expect(Object.fromEntries(new Headers(request?.headers))).toEqual({
      accept: "text/html",
      authorization: "Bearer matrix-bearer",
      origin: HOSTED_BOTS_ORIGIN,
      "x-matrix-hosted-bots-proxy": "1",
      "x-matrix-hosted-bots-session": cookieName + "=" + cookieValue,
    });
  });

  it("gives the upstream document only a public WSS base and permits only stock stream paths", async () => {
    const { handler, fetcher } = setup();
    fetcher.mockResolvedValue(new Response("<html><head></head><body>Bots</body></html>", {
      headers: { "content-type": "text/html; charset=utf-8" },
    }));
    const html = await (await handler(new Request(HOSTED_BOTS_ORIGIN + "/"))).text();
    const base = "wss://app.matrix-os.com/vm/pv-202-0123abcd/api/hosted-bots/runtime";
    expect(html).toContain('<meta name="matrix-bots-websocket-base" content="' + base + '">');
    expect(html).not.toContain("matrix-bearer");
    expect(html).not.toContain(cookieValue);
    const identity = hostedBotsIdentity(auth)!;
    expect(hostedBotsSocketAllowed(identity, base + "/api/bots/bot-1/browser/stream")).toBe(true);
    expect(hostedBotsSocketAllowed(identity, base + "/api/desktop-viewer/local/shared/websockify")).toBe(true);
    expect(hostedBotsSocketAllowed(identity, base + "/api/bots/bot-1/browser/settings")).toBe(false);
    expect(hostedBotsSocketAllowed(identity, base.replace("pv-202", "pv-203") + "/api/bots/bot-1/browser/stream")).toBe(false);
    expect(hostedBotsSocketAllowed(identity, base.replace("app.matrix-os.com", "elsewhere.test") + "/api/bots/bot-1/browser/stream")).toBe(false);
  });

  it("permits only supported public provider login pages", () => {
    expect(hostedBotsProviderLoginAllowed("https://auth.openai.com/codex/device")).toBe(true);
    expect(hostedBotsProviderLoginAllowed("https://claude.ai/oauth/authorize?code=true&state=fixture")).toBe(true);
    expect(hostedBotsProviderLoginAllowed("https://accounts.google.com/o/oauth2/v2/auth?response_type=code&redirect_uri=http%3A%2F%2F127.0.0.1%3A2345%2F")).toBe(true);
    for (const url of [
      "https://auth.openai.com/api/accounts/authorize",
      "https://auth.openai.com/codex/device?redirect_uri=https://outside.test",
      "https://claude.ai/oauth/authorize?redirect_uri=https://outside.test",
      "https://claude.ai/anything",
      "https://auth.openai.com.outside.test/codex/device",
      "http://127.0.0.1:2345/",
    ]) expect(hostedBotsProviderLoginAllowed(url)).toBe(false);
  });

  it("leaves a healthy live-events response open past the header deadline and still aborts on disconnect", async () => {
    vi.useFakeTimers();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
      const deadline = new AbortController();
      setTimeout(() => deadline.abort(), ms);
      return deadline.signal;
    });
    try {
      const { handler, fetcher } = setup();
      const caller = new AbortController();
      let requestSignal: AbortSignal | null | undefined;
      let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
      fetcher.mockImplementation(async (_target, init) => {
        requestSignal = init?.signal;
        return new Response(new ReadableStream({ start(controller) { stream = controller; } }), {
          headers: { "content-type": "text/event-stream" },
        });
      });
      const response = await handler(new Request(HOSTED_BOTS_ORIGIN + "/api/events?since=old:9", {
        signal: caller.signal, headers: { accept: "text/event-stream", "last-event-id": "old:12" },
      }));
      await vi.advanceTimersByTimeAsync(121_000);
      expect(requestSignal?.aborted).toBe(false);
      expect(new Headers(fetcher.mock.calls[0]?.[1]?.headers).get("last-event-id")).toBe("old:12");
      stream?.enqueue(new TextEncoder().encode("data: ping\n\n"));
      stream?.close();
      expect(await response.text()).toBe("data: ping\n\n");
      caller.abort();
      expect(requestSignal?.aborted).toBe(true);
    } finally {
      timeout.mockRestore();
      vi.useRealTimers();
    }
  });

  it("aborts a live-events request whose headers never arrive", async () => {
    vi.useFakeTimers();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
      const deadline = new AbortController();
      setTimeout(() => deadline.abort(), ms);
      return deadline.signal;
    });
    try {
      const { handler, fetcher } = setup();
      fetcher.mockImplementation(async (_target, init) => new Promise((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      }));
      const response = handler(new Request(HOSTED_BOTS_ORIGIN + "/api/events"));
      await vi.advanceTimersByTimeAsync(121_000);
      expect((await response).status).toBe(502);
    } finally {
      timeout.mockRestore();
      vi.useRealTimers();
    }
  });

  it("denies unexpected origins and invalidates all requests after an owner change", async () => {
    const { handler, changeScope, fetcher } = setup();
    expect((await handler(new Request("https://outside.test/"))).status).toBe(403);
    changeScope();
    expect((await handler(new Request(HOSTED_BOTS_ORIGIN + "/api/bots"))).status).toBe(403);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("does not follow a gateway redirect or install cookies after an owner switch", async () => {
    const { handler, changeScope, fetcher, set } = setup();
    fetcher.mockImplementation(async (_url, init) => {
      expect(init?.redirect).toBe("manual");
      changeScope();
      return new Response(null, { status: 302, headers: {
        location: "https://outside.test/",
        "set-cookie": cookieName + "=" + cookieValue + "; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=300",
      } });
    });
    expect((await handler(new Request(HOSTED_BOTS_ORIGIN + "/"))).status).toBe(403);
    expect(set).not.toHaveBeenCalled();
  });
});
