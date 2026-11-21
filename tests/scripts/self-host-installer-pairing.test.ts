import { spawnSync, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authMiddleware } from "../../packages/gateway/src/auth.js";
import { OwnerLoginStore, privateNetworkIdentityMiddleware } from "../../packages/gateway/src/private-network/identity.js";
import { JoinCodeRegistry } from "../../packages/gateway/src/private-network/join-codes.js";
import { PairingStore, bootstrapPrivateNetworkDatabase, type PrivateNetworkDatabase } from "../../packages/gateway/src/private-network/pairing-store.js";
import { createPrivateNetworkRoutes } from "../../packages/gateway/src/private-network/routes.js";
import { TailscaleController } from "../../packages/gateway/src/private-network/tailscale-cli.js";
import { createTestPGlite } from "../helpers/pglite-test-helper.js";

// Spec 2701 pairing: the second server's installer (producer) against the first
// computer's gateway routes (consumer). The shim adds only what tailscale serve
// (identity header) and nginx (bearer) add in production.
const TOKEN = "synthetic-pairing-owner-token";
const OWNER_LOGIN = "alice@example.com";

function pairClientSource(): string {
  const result = spawnSync("bash", ["-c", 'source "$INSTALLER"; pair_client_source'], {
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", INSTALLER: join(process.cwd(), "scripts/install-server.sh"), MATRIX_INSTALL_SOURCE_ONLY: "1" },
  });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout;
}

function runClient(source: string, env: Record<string, string>): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", source], { env: { PATH: process.env.PATH ?? "", ...env } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("exit", (status) => resolve({ status, stdout, stderr }));
  });
}

describe("installer machine pairing", () => {
  let db: Kysely<PrivateNetworkDatabase>;
  let home: string;
  let server: ReturnType<typeof serve>;
  let origin: string;
  let joinCodes: JoinCodeRegistry;

  beforeEach(async () => {
    vi.stubEnv("MATRIX_USER_ID", "self-host-matrix");
    const engine = await createTestPGlite();
    db = new Kysely<PrivateNetworkDatabase>({ dialect: engine.dialect });
    await bootstrapPrivateNetworkDatabase(db);
    home = await mkdtemp(join(tmpdir(), "matrix-join-"));
    const status = {
      BackendState: "Running",
      Self: { HostName: "primary", DNSName: "primary.tail1234.ts.net.", UserID: 1 },
      User: { "1": { LoginName: OWNER_LOGIN } },
      Peer: { a: { HostName: "second", DNSName: "second.tail1234.ts.net.", Online: true } },
    };
    const tailscale = new TailscaleController({
      exec: async () => ({ stdout: JSON.stringify(status), stderr: "" }), accessMode: "tailscale", loginServer: null, operator: "alice",
    });
    const ownerLogins = new OwnerLoginStore({ homePath: home, installLogin: OWNER_LOGIN });
    joinCodes = new JoinCodeRegistry();
    const gateway = new Hono();
    gateway.use("*", privateNetworkIdentityMiddleware({ accessMode: "tailscale", ownerLogin: () => ownerLogins.get() }));
    gateway.use("*", authMiddleware(TOKEN));
    gateway.route("/api/system/private-network", createPrivateNetworkRoutes({
      config: { selfHosted: true, accessMode: "tailscale", loginServer: null, installOwnerLogin: OWNER_LOGIN, runUser: "alice",
        updateChannel: null, ownerId: "self-host-matrix", machineId: "self-host-matrix", tailscaleBin: "/usr/bin/tailscale" },
      tailscale, ownerLogins, joinCodes, store: new PairingStore(db),
    }));
    server = serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request, env) => {
        const headers = new Headers(request.headers);
        headers.set("tailscale-user-login", OWNER_LOGIN);
        headers.set("authorization", `Bearer ${TOKEN}`);
        return gateway.fetch(new Request(request, { headers }), env);
      },
    });
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await db.destroy();
    await rm(home, { recursive: true, force: true });
  });

  it("generates a private key, pairs, and records the primary", async () => {
    const identityDir = join(home, "second-identity");
    await mkdir(identityDir, { mode: 0o700 });
    const { code } = joinCodes.issue();
    const env = { MATRIX_JOIN_URL: origin, MATRIX_JOIN_CODE: code, MATRIX_JOIN_IDENTITY_DIR: identityDir, MATRIX_JOIN_NAME: "second", MATRIX_JOIN_DNS_NAME: "second.tail1234.ts.net" };
    const result = await runClient(pairClientSource(), env);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("primary");
    expect((await stat(join(identityDir, "machine-ed25519.pem"))).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(join(identityDir, "paired-primary.json"), "utf8"))).toMatchObject({ name: "primary", dnsName: "primary.tail1234.ts.net", url: origin });
    const listed = await new PairingStore(db).list("self-host-matrix");
    expect(listed.machines.map((machine) => machine.dnsName)).toEqual(["second.tail1234.ts.net"]);

    // Re-running with the same identity and a fresh code re-pairs the same machine.
    const again = await runClient(pairClientSource(), { ...env, MATRIX_JOIN_CODE: joinCodes.issue().code });
    expect(again.status, again.stderr).toBe(0);
    expect((await new PairingStore(db).list("self-host-matrix")).machines).toHaveLength(1);
  });

  it("fails without leaking the code when it was already used", async () => {
    const identityDir = join(home, "identity");
    await mkdir(identityDir, { mode: 0o700 });
    const { code } = joinCodes.issue();
    const env = { MATRIX_JOIN_URL: origin, MATRIX_JOIN_CODE: code, MATRIX_JOIN_IDENTITY_DIR: identityDir, MATRIX_JOIN_NAME: "second", MATRIX_JOIN_DNS_NAME: "second.tail1234.ts.net" };
    expect((await runClient(pairClientSource(), env)).status).toBe(0);
    const reused = await runClient(pairClientSource(), env);
    expect(reused.status).not.toBe(0);
    expect(`${reused.stdout}${reused.stderr}`).not.toContain(code);
  });

  it("refuses plain HTTP to an address outside the private network", async () => {
    const identityDir = join(home, "identity-public");
    await mkdir(identityDir, { mode: 0o700 });
    const result = await runClient(pairClientSource(), {
      MATRIX_JOIN_URL: "http://192.0.2.10", MATRIX_JOIN_CODE: joinCodes.issue().code, MATRIX_JOIN_IDENTITY_DIR: identityDir,
      MATRIX_JOIN_NAME: "second", MATRIX_JOIN_DNS_NAME: "second.tail1234.ts.net",
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("not on the private network");
  });
});
