import { describe, expect, it, vi } from "vitest";
import {
  buildRendererCsp,
  installGatewayCors,
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

describe("installGatewayCors", () => {
  it("adds Access-Control-Allow-Origin for gateway responses", () => {
    const { session, fire } = corsSession();
    installGatewayCors(session, () => GATEWAY, "http://localhost:5173");
    const res = fire({ url: `${GATEWAY}/api/channels/status`, method: "GET", responseHeaders: { "content-type": ["application/json"] } });
    expect(res.responseHeaders?.["Access-Control-Allow-Origin"]).toEqual(["http://localhost:5173"]);
    expect(res.responseHeaders?.["Access-Control-Allow-Headers"]?.[0]).toContain("Authorization");
    expect(res.responseHeaders?.["Access-Control-Allow-Headers"]?.[0]).toContain("x-runtime-slot");
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
    expect(shouldInjectAuth("wss://app.matrix-os.com/ws/terminal/session?session=x", GATEWAY)).toBe(true);
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
