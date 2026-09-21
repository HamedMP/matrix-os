/**
 * S20 / T098: the organization is the only collaboration gate on the home
 * computer. No release flag or rollout cohort is consulted anywhere, wiring
 * with incomplete configuration fails closed with a logged generic denial
 * instead of skipping construction, and (later layers) every collaboration
 * request is denied while no membership projection is registered.
 */
import { Hono } from "hono";
import type { UpgradeWebSocket } from "hono/ws";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  describeGatewayCollaborationConfiguration,
  loadGatewayCollaborationConfig,
} from "../../packages/gateway/src/collaboration/config.js";
import { registerFailClosedCollaborationRoutes } from "../../packages/gateway/src/collaboration/fail-closed.js";
import { constructGatewayCollaborationOrFailClosed } from "../../packages/gateway/src/collaboration/construct.js";
import { COLLABORATION_HTTP_BODY_LIMIT } from "@matrix-os/contracts";

const completeEnvironment = {
  MATRIX_RUNTIME_ID: "vps:11111111-1111-4111-8111-111111111111",
  MATRIX_COLLABORATION_ACTIVE_KEY_ID: "key-1",
  MATRIX_COLLABORATION_PROOF_KEYS: JSON.stringify({ "key-1": "a".repeat(32) }),
  MATRIX_COLLABORATION_PREFLIGHT_SECRET: "b".repeat(32),
  PLATFORM_INTERNAL_URL: "https://platform.internal",
  UPGRADE_TOKEN: "c".repeat(32),
  DATABASE_URL: "postgres://owner@localhost/owner",
};

async function listSourceFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name.startsWith(".")) continue;
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...await listSourceFiles(path));
    else if (/\.(ts|tsx|yaml|yml|sh)$/.test(entry.name)) files.push(path);
  }
  return files;
}

describe("S20 organization precondition: no release flag", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("consults no MATRIX_COLLABORATION_ENABLED flag anywhere in runtime, distro or workflow sources", async () => {
    const roots = ["packages", "distro", ".github/workflows"];
    const offenders: string[] = [];
    for (const root of roots) {
      for (const file of await listSourceFiles(root)) {
        if ((await readFile(file, "utf8")).includes("MATRIX_COLLABORATION_ENABLED")) offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("treats a legacy host.env flag value as inert", () => {
    expect(loadGatewayCollaborationConfig({ ...completeEnvironment, MATRIX_COLLABORATION_ENABLED: "false" }))
      .toMatchObject({ runtimeId: completeEnvironment.MATRIX_RUNTIME_ID });
    expect(describeGatewayCollaborationConfiguration({ MATRIX_COLLABORATION_ENABLED: "true" }))
      .toEqual({ configured: false, reason: "runtime_identity_missing" });
  });

  it("reports the exact missing configuration instead of a flag", () => {
    expect(describeGatewayCollaborationConfiguration(completeEnvironment)).toEqual({ configured: true });
    const { MATRIX_COLLABORATION_PROOF_KEYS: _keys, ...withoutSigning } = completeEnvironment;
    expect(describeGatewayCollaborationConfiguration(withoutSigning))
      .toEqual({ configured: false, reason: "signing_configuration_missing" });
    const { UPGRADE_TOKEN: _token, ...withoutPlatform } = completeEnvironment;
    expect(describeGatewayCollaborationConfiguration(withoutPlatform))
      .toEqual({ configured: false, reason: "platform_configuration_missing" });
    const { DATABASE_URL: _db, ...withoutDatabase } = completeEnvironment;
    expect(describeGatewayCollaborationConfiguration(withoutDatabase))
      .toEqual({ configured: false, reason: "owner_database_missing" });
    expect(loadGatewayCollaborationConfig(withoutDatabase)).not.toBeNull();
  });
});

describe("S20 organization precondition: fail-closed wiring", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function build(reason: "signing_configuration_missing" | "owner_database_missing") {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const app = new Hono();
    const upgradeWebSocket = (() => async () => new Response(null, { status: 500 })) as unknown as UpgradeWebSocket;
    let clock = 1_000;
    registerFailClosedCollaborationRoutes({ app, upgradeWebSocket, reason, now: () => clock });
    return { app, warn, advance: (ms: number) => { clock += ms; } };
  }

  it("mounts every collaboration route and denies with one generic body when signing configuration is missing", async () => {
    const { app, warn } = build("signing_configuration_missing");
    expect(warn).toHaveBeenCalledWith("[collaboration] wiring fail-closed", "signing_configuration_missing");
    const requests = [
      app.request("/api/collaboration/scopes/10000000-0000-4000-8000-000000000001"),
      app.request("/api/collaboration/runtimes/vps:x/scopes", { method: "POST", body: "{}" }),
      app.request("/api/collaboration/scopes/10000000-0000-4000-8000-000000000001/chat/requests", { method: "POST", body: "{}" }),
      app.request("/api/collaboration/invitations/10000000-0000-4000-8000-000000000002/accept", { method: "POST", body: "{}" }),
      app.request("/api/collaboration/scopes/10000000-0000-4000-8000-000000000001/members/user_x", { method: "DELETE" }),
      app.request("/ws/collaboration/scopes/10000000-0000-4000-8000-000000000001/events", {
        headers: { upgrade: "websocket", connection: "Upgrade" },
      }),
      app.request("/ws/collaboration/scopes/10000000-0000-4000-8000-000000000001/terminal"),
    ];
    for (const response of await Promise.all(requests)) {
      expect(response.status).toBe(503);
      expect(response.headers.get("cache-control")).toBe("no-store");
      await expect(response.json()).resolves.toEqual({ error: "Collaboration unavailable" });
    }
  });

  it("applies the collaboration body limit to every mutating verb while fail-closed, DELETE included", async () => {
    const { app } = build("signing_configuration_missing");
    const oversized = "x".repeat(COLLABORATION_HTTP_BODY_LIMIT + 1);
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const response = await app.request("/api/collaboration/scopes/10000000-0000-4000-8000-000000000001/lifecycle", {
        method, body: oversized, headers: { "content-type": "application/json" },
      });
      expect(response.status).toBe(413);
      await expect(response.json()).resolves.toEqual({ error: "Request too large" });
    }
    const bounded = await app.request("/api/collaboration/scopes/10000000-0000-4000-8000-000000000001/lifecycle", {
      method: "DELETE", body: "{}",
    });
    expect(bounded.status).toBe(503);
  });

  it("logs denials with the configuration reason at a bounded rate and never leaks it to clients", async () => {
    const { app, warn, advance } = build("owner_database_missing");
    warn.mockClear();
    await app.request("/api/collaboration/inbox");
    await app.request("/api/collaboration/shared");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("[collaboration] request denied while fail-closed", "owner_database_missing");
    advance(61_000);
    const response = await app.request("/api/collaboration/shared");
    expect(warn).toHaveBeenCalledTimes(2);
    expect(await response.text()).not.toContain("owner_database_missing");
  });
});

describe("S20 organization precondition: construction failures fail closed", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns the runtime when construction and the partial-runtime step succeed", async () => {
    const runtime = { shutdown: vi.fn(async () => undefined) };
    const enable = vi.fn(async () => ({ available: true as const }));
    await expect(constructGatewayCollaborationOrFailClosed(async () => runtime, { onPartialRuntime: enable }))
      .resolves.toEqual({ ok: true, runtime });
    expect(enable).toHaveBeenCalledWith(runtime);
    expect(runtime.shutdown).not.toHaveBeenCalled();
  });

  it("maps a construction failure to the fail-closed reason with a generic log instead of throwing", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(constructGatewayCollaborationOrFailClosed(async () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:5432 password=secret");
    })).resolves.toEqual({ ok: false, reason: "construction_failed" });
    expect(error).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(error.mock.calls[0])).not.toContain("secret");
  });

  it("shuts down a partially built runtime when the follow-up step fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const runtime = { shutdown: vi.fn(async () => undefined) };
    await expect(constructGatewayCollaborationOrFailClosed(async () => runtime, {
      onPartialRuntime: async () => { throw new Error("inventory unavailable"); },
    })).resolves.toEqual({ ok: false, reason: "construction_failed" });
    expect(runtime.shutdown).toHaveBeenCalledOnce();
  });
});
