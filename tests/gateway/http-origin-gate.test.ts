import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { createAllowedOriginController } from "../../packages/gateway/src/allowed-origins.js";
import { authMiddleware } from "../../packages/gateway/src/auth.js";
import { registerBrowserOriginPolicies } from "../../packages/gateway/src/server/websocket-origin-gate.js";

// Fault detected: on a private self-hosted computer, Tailscale authenticates the
// device and nginx (or the shell proxy) adds the owner's bearer to every request.
// A page on another site, opened in the owner's browser, submits a form or a
// no-cors fetch to a mutating route (e.g. run a terminal command). CORS only
// hides the response; the mutation itself would still run as the owner.
const TOKEN = "t".repeat(48);
const TAILNET = "https://matrix.example-tailnet.ts.net";
const SELF_HOST_ENV = { MATRIX_SELF_HOSTED: "1", MATRIX_ACCESS_MODE: "tailscale", SHELL_ORIGIN: TAILNET, MATRIX_TAILNET_URL: TAILNET };
// What the ingress adds to every request, whatever page made it.
const injected = { Authorization: `Bearer ${TOKEN}` };
const UNSAFE = ["POST", "PUT", "PATCH", "DELETE"] as const;
const savedEnv = { ...process.env };

beforeEach(() => {
  Object.assign(process.env, { MATRIX_AUTH_TOKEN: TOKEN, MATRIX_USER_ID: "self-host-owner" });
  delete process.env.MATRIX_HANDLE;
  delete process.env.MATRIX_RUNTIME_SLOT;
});
afterEach(() => {
  process.env = { ...savedEnv };
});

/** The production order: browser-origin policies, then bearer auth, then the routes. */
function gateway(env: NodeJS.ProcessEnv) {
  const app = new Hono();
  const allowedOrigins = createAllowedOriginController({ shellOrigin: env.SHELL_ORIGIN, proxyOrigin: env.PROXY_ORIGIN });
  registerBrowserOriginPolicies(app, { env, allowedOrigins, devNullOrigin: false });
  app.use("*", authMiddleware(TOKEN));
  const ran: string[] = [];
  app.on([...UNSAFE], "/api/terminal/exec", (c) => { ran.push(c.req.method); return c.json({ ok: true }); });
  app.get("/api/terminal/list", (c) => c.json({ ok: true }));
  return {
    ran,
    send: (method: string, headers: Record<string, string>, path = "/api/terminal/exec") =>
      app.request(path, { method, headers: { ...injected, ...headers } }),
  };
}

describe("HTTP mutation Origin gate", () => {
  it("refuses every unsafe method from a foreign browser Origin before the route runs, even with the ingress's bearer", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const { ran, send } = gateway(SELF_HOST_ENV);
      for (const method of UNSAFE) {
        for (const origin of ["https://untrusted.example", "null", "http://matrix.example-tailnet.ts.net.evil.example"]) {
          const res = await send(method, { Origin: origin, "Content-Type": "text/plain" });
          expect(res.status, `${method} ${origin}`).toBe(403);
          expect(res.headers.get("access-control-allow-origin")).toBeNull();
        }
      }
      expect(ran).toEqual([]);
      // The Origin value is attacker-chosen and never logged.
      expect(JSON.stringify(warn.mock.calls)).not.toContain("untrusted.example");
    } finally {
      warn.mockRestore();
    }
  });

  it("refuses a cross-site unsafe request that carries no Origin but is marked cross-site by the browser", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const { ran, send } = gateway(SELF_HOST_ENV);
      for (const site of ["cross-site", "same-site"]) {
        expect((await send("POST", { "Sec-Fetch-Site": site })).status, site).toBe(403);
      }
      expect(ran).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });

  it("lets the shell's own origin (both tailnet schemes) and non-browser clients mutate", async () => {
    const { ran, send } = gateway(SELF_HOST_ENV);
    expect((await send("POST", { Origin: TAILNET })).status).toBe(200);
    expect((await send("DELETE", { Origin: "http://matrix.example-tailnet.ts.net" })).status).toBe(200);
    expect((await send("POST", { Origin: TAILNET, "Sec-Fetch-Site": "same-origin" })).status).toBe(200);
    // CLI, Electron main and machine clients send no Origin and still need the bearer.
    expect((await send("PUT", {})).status).toBe(200);
    expect((await send("PATCH", { "Sec-Fetch-Site": "none" })).status).toBe(200);
    expect(ran).toEqual(["POST", "DELETE", "POST", "PUT", "PATCH"]);
  });

  it("leaves safe methods to CORS: a foreign GET runs but its response is not readable", async () => {
    const { send } = gateway(SELF_HOST_ENV);
    const res = await send("GET", { Origin: "https://untrusted.example" }, "/api/terminal/list");
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    const preflight = await send("OPTIONS", { Origin: "https://untrusted.example", "Access-Control-Request-Method": "POST" });
    expect(preflight.status).not.toBe(403);
    expect(preflight.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("changes nothing where credentials are never ambient (managed computers, local dev, public self-host)", async () => {
    for (const env of [{}, { SHELL_ORIGIN: "https://app.matrix-os.com" }, { MATRIX_SELF_HOSTED: "1", MATRIX_ACCESS_MODE: "public" }]) {
      const { ran, send } = gateway(env);
      expect((await send("POST", { Origin: "https://untrusted.example" })).status, JSON.stringify(env)).toBe(200);
      expect(ran).toEqual(["POST"]);
    }
  });
});
