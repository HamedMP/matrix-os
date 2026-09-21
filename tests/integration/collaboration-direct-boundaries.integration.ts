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

  it("after S20 the platform consults no rollout policy or cohort on any request (S05/S18 still remove proof signing)", () => {
    for (const source of [proxy, websocket]) {
      expect(source).not.toContain("getPolicy(");
      expect(source).not.toContain("policyAllows(");
      expect(source).not.toContain("requirePolicy(");
      expect(source).not.toContain("x-matrix-collaboration-policy");
      expect(source).not.toContain("collaboration_rollout_policy");
    }
    expect(proxy).toContain("x-matrix-collaboration-proof");
  });

  it("today the platform still signs actor proofs and parses DELETE conditions before forwarding (S18 must invert this)", () => {
    expect(proxy).toContain("signHttp(");
    expect(proxy).toContain("CollaborationDeleteConditionSchema.safeParse(");
    expect(websocket).toContain("signSocket(");
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
  const scopeUrl = () => `${fixtures.relayUrl}/api/collaboration/scopes/${fixtures.scopeId}`;
  const authHeaders = () => ({ authorization: `Bearer ${fixtures.sessionToken}` });

  /**
   * Every negative probe first proves reachability with a valid request, so a DNS
   * failure, an unreachable relay or the probe's own timeout can never be mistaken
   * for a rejection.
   */
  async function assertRelayReachable(): Promise<void> {
    const control = await fetch(scopeUrl(), { headers: authHeaders(), signal: AbortSignal.timeout(10_000) });
    expect(control.status, "control request with valid auth must succeed before a negative probe").toBe(200);
  }

  async function loadWebSocket(): Promise<typeof import("ws").WebSocket> {
    const { createRequire } = await import("node:module");
    const gatewayRequire = createRequire(join(REPO_ROOT, "packages/gateway/package.json"));
    return ((await import(gatewayRequire.resolve("ws"))) as typeof import("ws")).WebSocket;
  }

  type UpgradeOutcome = { kind: "open" } | { kind: "refused"; status: number } | { kind: "closed"; code: number } | { kind: "error" } | { kind: "timeout" };

  async function upgradeWith(origin: string): Promise<UpgradeOutcome> {
    const WebSocket = await loadWebSocket();
    const url = `${(fixtures.relayUrl as string).replace(/^http/, "ws")}/api/collaboration/scopes/${fixtures.scopeId}/events?token=${encodeURIComponent(fixtures.sessionToken as string)}`;
    return new Promise<UpgradeOutcome>((resolveOutcome) => {
      const socket = new WebSocket(url, { headers: { origin } });
      const timer = setTimeout(() => { socket.terminate(); resolveOutcome({ kind: "timeout" }); }, 10_000);
      const settle = (outcome: UpgradeOutcome) => { clearTimeout(timer); resolveOutcome(outcome); };
      socket.once("open", () => { settle({ kind: "open" }); socket.close(); });
      socket.once("unexpected-response", (_req, res) => settle({ kind: "refused", status: res.statusCode ?? 0 }));
      socket.once("close", (code) => settle({ kind: "closed", code }));
      socket.once("error", () => settle({ kind: "error" }));
    });
  }

  it.skipIf(!relayReady)(
    `authenticated read reaches the home through the relay (${unrun("COLLABORATION_PROBE_RELAY_URL/SESSION_TOKEN/SCOPE_ID")})`,
    async () => {
      const response = await fetch(scopeUrl(), { headers: authHeaders(), signal: AbortSignal.timeout(10_000) });
      console.info("[s00-probe] relay authenticated read", { status: response.status });
      expect(response.status).toBe(200);
    },
    PROBE_TIMEOUT_MS,
  );

  it.skipIf(!relayReady)(
    `a forged proof header is rejected with 401/403 and no upstream detail (${unrun("COLLABORATION_PROBE_RELAY_URL/SESSION_TOKEN/SCOPE_ID")})`,
    async () => {
      await assertRelayReachable();
      const forged = Buffer.from(JSON.stringify({ keyId: "forged", signature: "AAAA", payload: { actorId: "user_forged" } })).toString("base64url");
      const response = await fetch(scopeUrl(), {
        headers: { ...authHeaders(), "x-matrix-collaboration-proof": forged },
        signal: AbortSignal.timeout(10_000),
      });
      const body = await response.text();
      console.info("[s00-probe] relay forged proof", { status: response.status });
      // A generic 404 or 400 would not prove the proof was verified and refused.
      expect([401, 403]).toContain(response.status);
      expect(body).not.toMatch(/postgres|kysely|ECONN|stack|at .*\.ts:/i);
    },
    PROBE_TIMEOUT_MS,
  );

  it.skipIf(!relayReady || !fixtures.allowedOrigin)(
    `a WebSocket upgrade with a foreign Origin is refused with 403 or policy-violation close (${unrun("COLLABORATION_PROBE_ALLOWED_ORIGIN")})`,
    async () => {
      await assertRelayReachable();
      const control = await upgradeWith(fixtures.allowedOrigin as string);
      console.info("[s00-probe] relay ws allowed origin", control);
      expect(control.kind, "upgrade with the allowed Origin must open before the negative probe").toBe("open");
      const foreign = await upgradeWith("https://attacker.example");
      console.info("[s00-probe] relay ws foreign origin", foreign);
      const refused = (foreign.kind === "refused" && foreign.status === 403)
        || (foreign.kind === "closed" && (foreign.code === 1008 || foreign.code === 4403));
      expect(refused, `expected 403 or close 1008/4403, observed ${JSON.stringify(foreign)}`).toBe(true);
    },
    PROBE_TIMEOUT_MS,
  );

  it.skipIf(!relayReady)(
    `an oversized body is refused with 413 before the home processes it (${unrun("COLLABORATION_PROBE_RELAY_URL/SESSION_TOKEN/SCOPE_ID")})`,
    async () => {
      await assertRelayReachable();
      const response = await fetch(`${scopeUrl()}/discussion/messages`, {
        method: "POST",
        headers: { ...authHeaders(), "content-type": "application/json" },
        body: JSON.stringify({ clientRequestId: "0b1f5f8e-2f0e-4c1e-9d5e-6a7b8c9d0e1f", text: "x".repeat(2 * 1024 * 1024) }),
        signal: AbortSignal.timeout(15_000),
      });
      console.info("[s00-probe] relay oversized body", { status: response.status });
      expect(response.status).toBe(413);
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
