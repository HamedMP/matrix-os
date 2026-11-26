import { describe, expect, it, vi } from "vitest";
import { createApiClient } from "@desktop/renderer/src/lib/api";
import {
  buildRendererCsp,
  installGatewayCors,
  installHeaderInjection,
  installSupportMessageAnalytics,
  shouldInjectAuth,
} from "@desktop/main/auth/header-injection";

const GATEWAY = "https://app.matrix-os.com";

function connectDirective(csp: string): string {
  return csp.split(";").map((part) => part.trim()).find((part) => part.startsWith("connect-src ")) ?? "";
}

function connectSources(csp: string): string[] {
  return connectDirective(csp).split(/\s+/).slice(1);
}

function scriptDirective(csp: string): string {
  return csp.split(";").map((part) => part.trim()).find((part) => part.startsWith("script-src ")) ?? "";
}

type HeadersReceivedListener = (
  details: {
    url: string;
    method: string;
    responseHeaders?: Record<string, string[]>;
    resourceType?: string;
  },
  callback: (response: { responseHeaders?: Record<string, string[]>; statusLine?: string }) => void,
) => void;

function corsSession() {
  let listener: HeadersReceivedListener | null = null;
  const session = {
    webRequest: {
      onBeforeSendHeaders: () => undefined,
      onHeadersReceived: (l: HeadersReceivedListener) => {
        listener = l;
      },
    },
  };
  return {
    session,
    fire(details: {
      url: string;
      method: string;
      responseHeaders?: Record<string, string[]>;
      resourceType?: string;
    }) {
      const cb = vi.fn();
      listener?.(details, cb);
      return cb.mock.calls[0]?.[0] ?? {};
    },
  };
}

type BeforeSendHeadersListener = (
  details: { url: string; method?: string; requestHeaders: Record<string, string> },
  callback: (response: { requestHeaders: Record<string, string> }) => void,
) => void;

function headerSession() {
  let listener: BeforeSendHeadersListener | null = null;
  const session = {
    webRequest: {
      onBeforeSendHeaders: (l: BeforeSendHeadersListener) => {
        listener = l;
      },
      onHeadersReceived: () => undefined,
    },
  };
  return {
    session,
    fire(url: string, requestHeaders: Record<string, string> = {}, method = "GET") {
      const cb = vi.fn();
      listener?.({ url, method, requestHeaders }, cb);
      return cb.mock.calls[0]?.[0]?.requestHeaders ?? {};
    },
  };
}

type BeforeRequestListener = (
  details: { url: string; method: string },
  callback: (response: Record<string, never>) => void,
) => void;
type CompletedListener = (details: { url: string; method: string; statusCode: number }) => void;
type ErrorListener = (details: { url: string; method: string; error: string }) => void;

function analyticsSession() {
  let beforeRequest: BeforeRequestListener | null = null;
  let completed: CompletedListener | null = null;
  let failed: ErrorListener | null = null;
  const session = {
    webRequest: {
      onBeforeRequest: (listener: BeforeRequestListener) => { beforeRequest = listener; },
      onCompleted: (listener: CompletedListener) => { completed = listener; },
      onErrorOccurred: (listener: ErrorListener) => { failed = listener; },
    },
  };
  return {
    session,
    attempt(details: { url: string; method: string }) {
      const callback = vi.fn();
      beforeRequest?.(details, callback);
      return callback;
    },
    complete(details: { url: string; method: string; statusCode: number }) {
      completed?.(details);
    },
    fail(details: { url: string; method: string; error: string }) {
      failed?.(details);
    },
  };
}

describe("installHeaderInjection", () => {
  it.each(["same", "account", "runtime", "origin", "signed-out"])("fences private request bytes before credential injection when the session is %s", async change => {
    let scope = { authGeneration: 3, runtimeSlot: "computer-a" };
    let origin = GATEWAY;
    let signedIn = true;
    const original = { ...scope };
    let listener!: (details: { url: string; requestHeaders: Record<string, string> }, callback: (decision: { requestHeaders: Record<string, string>; cancel?: boolean }) => void) => void;
    let dispatch!: () => void;
    const waitForDispatch = new Promise<void>(resolve => { dispatch = resolve; });
    const forwarded = vi.fn();
    const token = vi.fn(() => `fixture-owner-${scope.authGeneration}`);
    const session = { webRequest: { onBeforeSendHeaders: (value: typeof listener) => { listener = value; }, onHeadersReceived: () => {} } };
    installHeaderInjection(session, token, () => origin, "null", () => signedIn ? scope : null);
    const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
      await waitForDispatch;
      let decision!: { requestHeaders: Record<string, string>; cancel?: boolean };
      listener({ url, requestHeaders: Object.fromEntries(new Headers(init?.headers)) }, result => { decision = result; });
      if (decision.cancel) throw new DOMException("Canceled", "AbortError");
      forwarded(url, init?.body, decision.requestHeaders);
      return Response.json({ ok: true });
    });
    const api = createApiClient({ baseUrl: GATEWAY, getRuntimeSlot: () => scope.runtimeSlot, fetchFn, session: original });
    const request = api.post("/api/chats/chat_private/side-chat/turns", { text: "Original owner's private question" });
    if (change === "account") scope = { ...scope, authGeneration: 4 };
    if (change === "runtime") scope = { ...scope, runtimeSlot: "computer-b" };
    if (change === "origin") origin = "https://replacement.matrix.test";
    if (change === "signed-out") signedIn = false;
    dispatch();
    if (change === "same") {
      await expect(request).resolves.toEqual({ ok: true });
      expect(forwarded).toHaveBeenCalledWith(expect.stringContaining("runtime=computer-a"), expect.stringContaining("private question"), expect.objectContaining({ Authorization: "Bearer fixture-owner-3" }));
      expect(Object.keys(forwarded.mock.calls[0]![2]).some(key => key.toLowerCase() === "x-matrix-session")).toBe(false);
    } else {
      await expect(request).rejects.toBeInstanceOf(Error);
      expect(forwarded).not.toHaveBeenCalled();
      expect(token).not.toHaveBeenCalled();
    }
  });

  it("sets the trusted Matrix OS referrer for packaged Support widget calls", () => {
    const { session, fire } = headerSession();
    installHeaderInjection(session, () => null, () => GATEWAY, "null");

    const headers = fire(`${GATEWAY}/relay/api/conversations/v1/widget/message`);

    expect(headers.Referer).toBe("https://app.matrix-os.com/");
  });

  it("does not add the Support referrer to analytics or unrelated requests", () => {
    const { session, fire } = headerSession();
    installHeaderInjection(session, () => null, () => GATEWAY, "null");

    expect(fire(`${GATEWAY}/relay/i/v0/e/`).Referer).toBeUndefined();
    expect(fire(`${GATEWAY}/api/apps`).Referer).toBeUndefined();
    expect(fire("https://eu.i.posthog.com/api/conversations/v1/widget/message").Referer)
      .toBeUndefined();
  });

  it("does not rewrite Support referrers for the localhost development renderer", () => {
    const { session, fire } = headerSession();
    installHeaderInjection(session, () => null, () => GATEWAY, "http://localhost:5173");

    const headers = fire(`${GATEWAY}/relay/api/conversations/v1/widget/message`);

    expect(headers.Referer).toBeUndefined();
  });

  it("keeps the official Matrix OS referrer when a packaged build targets a preview gateway", () => {
    const previewGateway = "https://pr-1366---matrix-platform-preview.example.run.app";
    const { session, fire } = headerSession();
    installHeaderInjection(session, () => null, () => previewGateway, "null");

    const headers = fire(`${previewGateway}/relay/api/conversations/v1/widget/message`);

    expect(headers.Referer).toBe("https://app.matrix-os.com/");
  });

  it("preserves gateway Authorization injection alongside the packaged Support referrer", () => {
    const { session, fire } = headerSession();
    installHeaderInjection(session, () => "matrix-token", () => GATEWAY, "null");

    const headers = fire(`${GATEWAY}/relay/api/conversations/v1/widget/messages/ticket-1`);

    expect(headers).toEqual({
      Authorization: "Bearer matrix-token",
      Referer: "https://app.matrix-os.com/",
    });
  });
});

describe("gateway WebSocket Origin", () => {
  // A private self-hosted gateway refuses browser WebSocket upgrades from an
  // Origin other than its own shell. The packaged renderer is a file:// page
  // (Origin "null", which a sandboxed frame on any site can also send) and the
  // dev renderer is on localhost, so the trusted core names the gateway itself.
  it("sends the gateway's own origin on renderer WebSockets to the active gateway", () => {
    const tailnet = "https://matrix.example-tailnet.ts.net";
    for (const rendererOrigin of ["null", "http://localhost:5173"]) {
      const { session, fire } = headerSession();
      installHeaderInjection(session, () => "matrix-token", () => tailnet, rendererOrigin);
      expect(fire(`wss://matrix.example-tailnet.ts.net/ws/terminal/herdr?id=t1`, { Origin: rendererOrigin })).toEqual({
        Authorization: "Bearer matrix-token",
        Origin: tailnet,
      });
      expect(fire("ws://matrix.example-tailnet.ts.net:80/ws/terminal/tab", { origin: "null" }).Origin).toBeUndefined();
    }
    const plain = headerSession();
    installHeaderInjection(plain.session, () => null, () => "http://matrix.example-tailnet.ts.net", "null");
    const headers = plain.fire("ws://matrix.example-tailnet.ts.net/ws/terminal/tab", { origin: "null" });
    expect(headers).toEqual({ Origin: "http://matrix.example-tailnet.ts.net" });
  });

  // Review P1 (Greptile, #3530 at bed14b4e4e): the gateway also refuses
  // state-changing HTTP requests from a foreign browser Origin, so the packaged
  // renderer's writes (Origin "null") were refused on private self-hosted computers.
  it("sends the gateway's own origin on renderer writes to the active gateway", () => {
    const tailnet = "https://matrix.example-tailnet.ts.net";
    const { session, fire } = headerSession();
    installHeaderInjection(session, () => "matrix-token", () => tailnet, "null");
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      expect(fire(`${tailnet}/api/terminal/herdr/sessions/t1`, { Origin: "null" }, method), method).toEqual({
        Authorization: "Bearer matrix-token",
        Origin: tailnet,
      });
    }
  });

  it("leaves reads and other hosts' requests with the renderer's own Origin", () => {
    const { session, fire } = headerSession();
    installHeaderInjection(session, () => null, () => GATEWAY, "null");
    for (const method of ["GET", "HEAD", "OPTIONS"]) {
      expect(fire(`${GATEWAY}/api/apps`, { Origin: "null" }, method).Origin, method).toBe("null");
    }
    expect(fire("wss://evil.example/ws", { Origin: "null" }).Origin).toBe("null");
    expect(fire("https://evil.example/api/apps", { Origin: "null" }, "POST").Origin).toBe("null");
  });
});

describe("installGatewayCors", () => {
  it("permits canonical chat metadata and resumable stream preflights", () => {
    const { session, fire } = corsSession();
    installGatewayCors(session, () => GATEWAY, "null");
    const res = fire({ url: `${GATEWAY}/api/chats/chat-1/events`, method: "OPTIONS" });
    const allowed = res.responseHeaders?.["Access-Control-Allow-Headers"]?.[0]
      .toLowerCase().split(/,\s*/);
    expect(allowed).toEqual(expect.arrayContaining([
      "x-matrix-chat-metadata", "x-matrix-chat-import-source", "x-matrix-chat-protocol", "last-event-id", "x-matrix-session",
    ]));
  });

  it("permits the direct collaboration headers the shared client sends to the platform relay", () => {
    const { session, fire } = corsSession();
    installGatewayCors(session, () => GATEWAY, "null");
    const res = fire({ url: `${GATEWAY}/api/collaboration/direct-sessions`, method: "OPTIONS" });
    const allowed = res.responseHeaders?.["Access-Control-Allow-Headers"]?.[0]
      .toLowerCase().split(/,\s*/);
    expect(allowed).toEqual(expect.arrayContaining([
      "x-matrix-collaboration-session", "x-matrix-collaboration-request", "x-matrix-collaboration-runtime",
      "x-matrix-collaboration-owner-runtime", "x-matrix-client-request-id", "x-matrix-expected-revision",
      "x-matrix-expected-member-revision",
    ]));
  });

  it("adds Access-Control-Allow-Origin for gateway responses", () => {
    const { session, fire } = corsSession();
    installGatewayCors(session, () => GATEWAY, "http://localhost:5173");
    const res = fire({ url: `${GATEWAY}/api/channels/status`, method: "GET", responseHeaders: { "content-type": ["application/json"] } });
    expect(res.responseHeaders?.["Access-Control-Allow-Origin"]).toEqual(["http://localhost:5173"]);
    expect(res.responseHeaders?.["Access-Control-Allow-Headers"]?.[0]).toContain("Authorization");
    expect(res.responseHeaders?.["Access-Control-Allow-Headers"]?.[0]).toContain("x-runtime-slot");
    expect(res.responseHeaders?.["Access-Control-Allow-Headers"]?.[0]).toContain("X-Matrix-Filename");
    expect(res.responseHeaders?.["Access-Control-Allow-Headers"]?.[0]).toContain("X-Conversations-Token");
    expect(res.responseHeaders?.["Access-Control-Allow-Credentials"]).toEqual(["true"]);
    expect(res.responseHeaders?.["content-type"]).toEqual(["application/json"]);
  });

  it("answers preflight OPTIONS with 200", () => {
    const { session, fire } = corsSession();
    installGatewayCors(session, () => GATEWAY, "null");
    const res = fire({ url: `${GATEWAY}/api/projects/x/tasks`, method: "OPTIONS" });
    expect(res.statusLine).toBe("HTTP/1.1 200 OK");
    expect(res.responseHeaders?.["Access-Control-Allow-Origin"]).toEqual(["null"]);
  });

  it("strips any upstream ACAO to avoid duplicates", () => {
    const { session, fire } = corsSession();
    installGatewayCors(session, () => GATEWAY, "http://localhost:5173");
    const res = fire({
      url: `${GATEWAY}/api/apps`,
      method: "GET",
      responseHeaders: { "Access-Control-Allow-Origin": ["https://app.matrix-os.com"] },
    });
    expect(res.responseHeaders?.["Access-Control-Allow-Origin"]).toEqual(["http://localhost:5173"]);
  });

  it("preserves upstream exposed headers while replacing allow headers", () => {
    const { session, fire } = corsSession();
    installGatewayCors(session, () => GATEWAY, "http://localhost:5173");
    const res = fire({
      url: `${GATEWAY}/api/apps`,
      method: "GET",
      responseHeaders: {
        "Access-Control-Allow-Origin": ["https://app.matrix-os.com"],
        "Access-Control-Expose-Headers": ["ETag, X-Matrix-Version"],
      },
    });
    expect(res.responseHeaders?.["Access-Control-Allow-Origin"]).toEqual(["http://localhost:5173"]);
    expect(res.responseHeaders?.["Access-Control-Expose-Headers"]).toEqual(["ETag, X-Matrix-Version"]);
    expect(res.responseHeaders?.["Access-Control-Allow-Credentials"]).toEqual(["true"]);
  });

  it("leaves non-gateway responses untouched", () => {
    const { session, fire } = corsSession();
    installGatewayCors(session, () => GATEWAY, "http://localhost:5173");
    const res = fire({ url: "https://evil.example.com/api", method: "GET", responseHeaders: { x: ["1"] } });
    expect(res.responseHeaders).toBeUndefined();
  });

  it("injects a gateway-scoped CSP for the packaged renderer document", () => {
    const { session, fire } = corsSession();
    installGatewayCors(session, () => GATEWAY, "null");
    const res = fire({
      url: "file:///Applications/Matrix%20OS.app/Contents/Resources/app.asar/out/renderer/index.html",
      method: "GET",
      resourceType: "mainFrame",
      responseHeaders: { "Content-Security-Policy": ["connect-src https:"] },
    });
    const csp = res.responseHeaders?.["Content-Security-Policy"]?.[0] ?? "";
    const connect = connectDirective(csp);
    const sources = connectSources(csp);

    expect(connect).toBe("connect-src 'self' https://app.matrix-os.com wss://app.matrix-os.com");
    expect(sources).not.toContain("https:");
    expect(sources).not.toContain("wss:");
    expect(sources).not.toContain("*");
    expect(sources).not.toContain("https://evil.example.com");
  });

  it("includes the Vite renderer origin for development HMR without broad external connect", () => {
    const csp = buildRendererCsp("http://localhost:18789", "http://localhost:5173");
    const connect = connectDirective(csp);
    const sources = connectSources(csp);

    expect(connect).toBe(
      "connect-src 'self' http://localhost:18789 ws://localhost:18789 http://localhost:5173 ws://localhost:5173",
    );
    expect(sources).not.toContain("https:");
    expect(sources).not.toContain("wss:");
    expect(sources).not.toContain("*");
  });

  it("keeps packaged renderer scripts strict", () => {
    const csp = buildRendererCsp(GATEWAY, "null");
    expect(scriptDirective(csp)).toBe("script-src 'self'");
  });

  it("allows blob: images so object-URL previews render in the packaged app", () => {
    const csp = buildRendererCsp(GATEWAY, "null");
    const imgDirective = csp.split(";").map((part) => part.trim()).find((part) => part.startsWith("img-src "));
    expect(imgDirective).toBe("img-src 'self' data: blob: https:");
  });

  it("allows Vite React Refresh inline preamble for localhost development renderers with explicit ports", () => {
    const localhostCsp = buildRendererCsp(GATEWAY, "http://localhost:3000");
    const loopbackCsp = buildRendererCsp(GATEWAY, "http://127.0.0.1:5173");
    const ipv6LoopbackCsp = buildRendererCsp(GATEWAY, "http://[::1]:5173");

    expect(scriptDirective(localhostCsp)).toBe("script-src 'self' 'unsafe-inline'");
    expect(scriptDirective(loopbackCsp)).toBe("script-src 'self' 'unsafe-inline'");
    expect(scriptDirective(ipv6LoopbackCsp)).toBe("script-src 'self' 'unsafe-inline'");
  });

  it("keeps non-dev renderer scripts strict", () => {
    const productionCsp = buildRendererCsp(GATEWAY, "https://app.matrix-os.com");
    const packagedCsp = buildRendererCsp(GATEWAY, "null");
    const remoteHttpCsp = buildRendererCsp(GATEWAY, "http://192.0.2.10:5173");
    const portlessLocalhostCsp = buildRendererCsp(GATEWAY, "http://localhost");
    const remoteCsp = buildRendererCsp(GATEWAY, "https://preview.example.com");

    expect(scriptDirective(productionCsp)).toBe("script-src 'self'");
    expect(scriptDirective(packagedCsp)).toBe("script-src 'self'");
    expect(scriptDirective(remoteHttpCsp)).toBe("script-src 'self'");
    expect(scriptDirective(portlessLocalhostCsp)).toBe("script-src 'self'");
    expect(scriptDirective(remoteCsp)).toBe("script-src 'self'");
  });
});

describe("shouldInjectAuth", () => {
  it("injects for exact-origin https requests", () => {
    expect(shouldInjectAuth("https://app.matrix-os.com/api/workspace/projects", GATEWAY)).toBe(true);
    expect(shouldInjectAuth("https://app.matrix-os.com/ws?x=1", GATEWAY)).toBe(true);
  });

  it("injects for websocket upgrades to the same host", () => {
    expect(shouldInjectAuth("wss://app.matrix-os.com/ws/terminal/tab?workspaceId=tws_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&tabId=tt_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", GATEWAY)).toBe(true);
  });

  it("never injects for other origins", () => {
    expect(shouldInjectAuth("https://evil.example.com/api", GATEWAY)).toBe(false);
    expect(shouldInjectAuth("https://matrix-os.com/", GATEWAY)).toBe(false);
    expect(shouldInjectAuth("https://app.matrix-os.com.attacker.tld/api", GATEWAY)).toBe(false);
    expect(shouldInjectAuth("https://sub.app.matrix-os.com/api", GATEWAY)).toBe(false);
  });

  it("never downgrades to plain http for a https gateway", () => {
    expect(shouldInjectAuth("http://app.matrix-os.com/api", GATEWAY)).toBe(false);
    expect(shouldInjectAuth("ws://app.matrix-os.com/ws", GATEWAY)).toBe(false);
  });

  it("supports http+ws for localhost dev gateways", () => {
    const dev = "http://localhost:18789";
    expect(shouldInjectAuth("http://localhost:18789/api/apps", dev)).toBe(true);
    expect(shouldInjectAuth("ws://localhost:18789/ws", dev)).toBe(true);
    expect(shouldInjectAuth("http://localhost:9999/api", dev)).toBe(false);
  });

  it("handles ports strictly", () => {
    expect(shouldInjectAuth("https://app.matrix-os.com:8443/api", GATEWAY)).toBe(false);
  });

  it("rejects garbage urls and null origins", () => {
    expect(shouldInjectAuth("not a url", GATEWAY)).toBe(false);
    expect(shouldInjectAuth("https://app.matrix-os.com/api", null)).toBe(false);
  });
});

describe("installSupportMessageAnalytics", () => {
  it("emits only allowlisted attempt and success events for the exact Support POST", () => {
    const { session, attempt, complete } = analyticsSession();
    const emit = vi.fn();
    installSupportMessageAnalytics(session, () => GATEWAY, emit);
    const details = {
      url: `${GATEWAY}/relay/api/conversations/v1/widget/message`,
      method: "POST",
    };

    expect(attempt(details)).toHaveBeenCalledWith({});
    complete({ ...details, statusCode: 201 });

    expect(emit.mock.calls).toEqual([
      [{ name: "desktop_support_send_attempted" }],
      [{ name: "desktop_support_send_succeeded" }],
    ]);
  });

  it("reduces HTTP and network failures to coarse kinds without raw details", () => {
    const { session, complete, fail } = analyticsSession();
    const emit = vi.fn();
    installSupportMessageAnalytics(session, () => GATEWAY, emit);
    const details = {
      url: `${GATEWAY}/relay/api/conversations/v1/widget/message`,
      method: "POST",
    };

    complete({ ...details, statusCode: 403 });
    complete({ ...details, statusCode: 503 });
    fail({ ...details, error: "net::ERR_FAILED token=/home/matrix/private" });

    expect(emit.mock.calls).toEqual([
      [{ name: "desktop_support_send_failed", failureKind: "client" }],
      [{ name: "desktop_support_send_failed", failureKind: "server" }],
      [{ name: "desktop_support_send_failed", failureKind: "network" }],
    ]);
    expect(JSON.stringify(emit.mock.calls)).not.toContain("ERR_FAILED");
    expect(JSON.stringify(emit.mock.calls)).not.toContain("/home/matrix");
  });

  it("ignores GETs, other paths, and non-gateway origins", () => {
    const { session, attempt, complete, fail } = analyticsSession();
    const emit = vi.fn();
    installSupportMessageAnalytics(session, () => GATEWAY, emit);

    attempt({ url: `${GATEWAY}/relay/api/conversations/v1/widget/message`, method: "GET" });
    complete({ url: `${GATEWAY}/relay/i/v0/e/`, method: "POST", statusCode: 200 });
    fail({
      url: "https://eu.i.posthog.com/api/conversations/v1/widget/message",
      method: "POST",
      error: "net::ERR_FAILED",
    });

    expect(emit).not.toHaveBeenCalled();
  });
});
