/**
 * S00 / T004 — relay, ticket and sandbox boundary probes for spec 124.
 *
 * Runs under `bun run test:integration`. Static characterization of the
 * current platform proxy and of the scope-runtime systemd profile always
 * runs. Live relay probes need an enrolled home reachable through the
 * platform relay; sandbox escape probes need a systemd host with root.
 * Missing fixtures report UNRUN with the fixture named.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { FIXED_SYSTEMD_PROPERTIES, FIXED_SYSTEMD_ENVIRONMENT } from "../../packages/scope-runtime/src/profile";

const REPO_ROOT = resolve(__dirname, "../..");
const PROBE_TIMEOUT_MS = 60_000;

const fixtures = {
  relayUrl: process.env.COLLABORATION_PROBE_RELAY_URL,
  sessionToken: process.env.COLLABORATION_PROBE_SESSION_TOKEN,
  scopeId: process.env.COLLABORATION_PROBE_SCOPE_ID,
  allowedOrigin: process.env.COLLABORATION_PROBE_ALLOWED_ORIGIN,
  sandboxHost: process.env.COLLABORATION_PROBE_SCOPE_RUNTIME_HOST === "1",
} as const;

const unrun = (fixture: string): string => `unrun: fixture ${fixture} missing`;
const relayReady = Boolean(fixtures.relayUrl && fixtures.sessionToken && fixtures.scopeId);

function systemdRunAvailable(): boolean {
  return process.getuid?.() === 0 && spawnSync("systemd-run", ["--version"], { encoding: "utf8" }).status === 0;
}

describe("S00 direct probes: baseline characterization of the platform proxy (always run)", () => {
  const proxy = readFileSync(join(REPO_ROOT, "packages/platform/src/collaboration/proxy.ts"), "utf8");
  const websocket = readFileSync(join(REPO_ROOT, "packages/platform/src/collaboration/websocket.ts"), "utf8");

  it("today the platform makes a per-request policy decision and parses request bodies (S05/S18 must invert this)", () => {
    expect(proxy).toContain("getPolicy(");
    expect(proxy).toContain("policyAllows(");
    expect(proxy).toContain("JSON.parse(new TextDecoder().decode(body))");
    expect(proxy).toContain("x-matrix-collaboration-proof");
  });

  it("today the platform WebSocket bridge requires a platform policy before forwarding", () => {
    expect(websocket).toContain("requirePolicy(");
    expect(websocket).toContain("x-matrix-collaboration-policy");
  });
});

describe("S00 direct probes: required supervisor facilities in the scope-runtime profile (always run)", () => {
  const properties = FIXED_SYSTEMD_PROPERTIES as readonly string[];

  it("isolates network, home, credentials and privileges for every shared run", () => {
    for (const required of [
      "DynamicUser=yes", "PrivateUsers=yes", "PrivateNetwork=yes", "ProtectHome=yes", "ProtectSystem=strict",
      "ProtectProc=invisible", "ProcSubset=pid", "NoNewPrivileges=yes", "CapabilityBoundingSet=",
      "RestrictNamespaces=yes", "MemoryMax=1073741824", "TasksMax=256", "RuntimeMaxSec=90",
    ]) expect(properties).toContain(required);
    expect(properties.some((p) => p.startsWith("RootDirectory="))).toBe(true);
  });

  it("never binds owner credential or forge paths into the workload", () => {
    const binds = properties.filter((p) => p.startsWith("BindPaths=") || p.startsWith("BindReadOnlyPaths="));
    for (const bind of binds) {
      expect(bind).not.toMatch(/\.codex|\.claude|\.config\/gh|git-credentials|\.ssh|\.netrc|host\.env/);
    }
    expect(binds.some((b) => b.includes("/run/matrix-scope/broker.sock"))).toBe(true);
    expect(FIXED_SYSTEMD_ENVIRONMENT).toContain("HOME=/workspace");
  });
});

describe("S00 direct probes: relay pass-through and home ticket verification", () => {
  it.skipIf(!relayReady)(
    `authenticated read reaches the home through the relay (${unrun("COLLABORATION_PROBE_RELAY_URL/SESSION_TOKEN/SCOPE_ID")})`,
    async () => {
      const response = await fetch(`${fixtures.relayUrl}/api/collaboration/scopes/${fixtures.scopeId}`, {
        headers: { authorization: `Bearer ${fixtures.sessionToken}` },
        signal: AbortSignal.timeout(10_000),
      });
      console.info("[s00-probe] relay authenticated read", { status: response.status });
      expect(response.status).toBe(200);
    },
    PROBE_TIMEOUT_MS,
  );

  it.skipIf(!relayReady)(
    `a forged proof header is rejected and the response carries no upstream detail (${unrun("COLLABORATION_PROBE_RELAY_URL/SESSION_TOKEN/SCOPE_ID")})`,
    async () => {
      const forged = Buffer.from(JSON.stringify({ keyId: "forged", signature: "AAAA", payload: { actorId: "user_forged" } })).toString("base64url");
      const response = await fetch(`${fixtures.relayUrl}/api/collaboration/scopes/${fixtures.scopeId}`, {
        headers: { authorization: `Bearer ${fixtures.sessionToken}`, "x-matrix-collaboration-proof": forged },
        signal: AbortSignal.timeout(10_000),
      });
      const body = await response.text();
      console.info("[s00-probe] relay forged proof", { status: response.status });
      expect([400, 401, 403, 404]).toContain(response.status);
      expect(body).not.toMatch(/postgres|kysely|ECONN|stack|at .*\.ts:/i);
    },
    PROBE_TIMEOUT_MS,
  );

  it.skipIf(!relayReady || !fixtures.allowedOrigin)(
    `a WebSocket upgrade with a foreign Origin is refused (${unrun("COLLABORATION_PROBE_ALLOWED_ORIGIN")})`,
    async () => {
      const { createRequire } = await import("node:module");
      const gatewayRequire = createRequire(join(REPO_ROOT, "packages/gateway/package.json"));
      const { WebSocket } = (await import(gatewayRequire.resolve("ws"))) as typeof import("ws");
      const url = `${(fixtures.relayUrl as string).replace(/^http/, "ws")}/api/collaboration/scopes/${fixtures.scopeId}/events?token=${encodeURIComponent(fixtures.sessionToken as string)}`;
      const outcome = await new Promise<string>((resolveOutcome) => {
        const socket = new WebSocket(url, { headers: { origin: "https://attacker.example" } });
        const timer = setTimeout(() => { socket.terminate(); resolveOutcome("timeout"); }, 10_000);
        socket.once("open", () => { clearTimeout(timer); socket.close(); resolveOutcome("open"); });
        socket.once("unexpected-response", (_req, res) => { clearTimeout(timer); resolveOutcome(`refused:${res.statusCode}`); });
        socket.once("error", () => { clearTimeout(timer); resolveOutcome("error"); });
      });
      console.info("[s00-probe] relay ws foreign origin", { outcome });
      expect(outcome).not.toBe("open");
    },
    PROBE_TIMEOUT_MS,
  );

  it.skipIf(!relayReady)(
    `an oversized body is refused before the home processes it (${unrun("COLLABORATION_PROBE_RELAY_URL/SESSION_TOKEN/SCOPE_ID")})`,
    async () => {
      const response = await fetch(`${fixtures.relayUrl}/api/collaboration/scopes/${fixtures.scopeId}/discussion/messages`, {
        method: "POST",
        headers: { authorization: `Bearer ${fixtures.sessionToken}`, "content-type": "application/json" },
        body: JSON.stringify({ clientRequestId: "0b1f5f8e-2f0e-4c1e-9d5e-6a7b8c9d0e1f", text: "x".repeat(2 * 1024 * 1024) }),
        signal: AbortSignal.timeout(15_000),
      });
      console.info("[s00-probe] relay oversized body", { status: response.status });
      expect([400, 413]).toContain(response.status);
    },
    PROBE_TIMEOUT_MS,
  );
});

describe("S00 direct probes: sandbox escape denial on a systemd host", () => {
  const ready = fixtures.sandboxHost && systemdRunAvailable();
  const escape = (script: string) => spawnSync("systemd-run", [
    "--wait", "--pipe", "--quiet", "--collect",
    "-p", "DynamicUser=yes", "-p", "PrivateUsers=yes", "-p", "PrivateNetwork=yes", "-p", "ProtectHome=yes",
    "-p", "ProtectSystem=strict", "-p", "ProtectProc=invisible", "-p", "ProcSubset=pid", "-p", "NoNewPrivileges=yes",
    "-p", "CapabilityBoundingSet=", "-p", "PrivateTmp=yes", "-p", "RuntimeMaxSec=30",
    "/bin/sh", "-c", script,
  ], { encoding: "utf8", timeout: 45_000 });

  it.skipIf(!ready)(`owner credential files are unreachable (${unrun("COLLABORATION_PROBE_SCOPE_RUNTIME_HOST=1 on a root systemd host")})`, () => {
    const result = escape("cat /home/*/.codex/auth.json /home/*/.claude/.credentials.json /root/.config/gh/hosts.json 2>/dev/null | head -c 1");
    expect(result.stdout).toBe("");
  }, PROBE_TIMEOUT_MS);

  it.skipIf(!ready)(`process environment of other services is invisible (${unrun("COLLABORATION_PROBE_SCOPE_RUNTIME_HOST=1")})`, () => {
    const result = escape("ls /proc | grep -E '^[0-9]+$' | wc -l");
    expect(Number(result.stdout.trim())).toBeLessThanOrEqual(2);
  }, PROBE_TIMEOUT_MS);

  it.skipIf(!ready)(`outbound network is denied (${unrun("COLLABORATION_PROBE_SCOPE_RUNTIME_HOST=1")})`, () => {
    const result = escape("(curl -m 5 -sS https://api.openai.com >/dev/null 2>&1 || wget -T 5 -q -O /dev/null https://api.openai.com) && echo reached || echo denied");
    expect(result.stdout.trim()).toBe("denied");
  }, PROBE_TIMEOUT_MS);

  it.skipIf(!ready)(`host Git object stores outside the workspace are unreadable (${unrun("COLLABORATION_PROBE_SCOPE_RUNTIME_HOST=1")})`, () => {
    const result = escape("ls /home/*/home/projects/*/.git/objects 2>/dev/null | head -c 1");
    expect(result.stdout).toBe("");
  }, PROBE_TIMEOUT_MS);
});
