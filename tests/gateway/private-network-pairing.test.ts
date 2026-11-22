import { generateKeyPairSync, sign, createPublicKey, type KeyObject } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { Kysely, type KyselyPlugin } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authMiddleware } from "../../packages/gateway/src/auth.js";
import { JoinCodeRegistry } from "../../packages/gateway/src/private-network/join-codes.js";
import {
  PairingStore,
  PairingStoreError,
  bootstrapPrivateNetworkDatabase,
  type PrivateNetworkDatabase,
} from "../../packages/gateway/src/private-network/pairing-store.js";
import { createPrivateNetworkRoutes, pairingMessage } from "../../packages/gateway/src/private-network/routes.js";
import { OwnerLoginStore, privateNetworkIdentityMiddleware } from "../../packages/gateway/src/private-network/identity.js";
import { TailscaleController, type TailscaleExec } from "../../packages/gateway/src/private-network/tailscale-cli.js";
import { createTestPGlite } from "../helpers/pglite-test-helper.js";

const OWNER = "self-host-matrix";
const TOKEN = "synthetic-private-network-owner-token";

describe("join codes", () => {
  it("are single use, hashed, short-lived and capped", () => {
    let now = 1_000_000;
    const registry = new JoinCodeRegistry({ now: () => now, ttlMs: 15 * 60_000, maxActive: 2 });
    const first = registry.issue();
    expect(first.code).toMatch(/^mxj_[A-Za-z0-9_-]{32}$/);
    expect(new Date(first.expiresAt).getTime() - now).toBe(15 * 60_000);
    expect(JSON.stringify(registry.debugEntries())).not.toContain(first.code);

    const challenge = registry.beginChallenge(first.code, 3);
    expect(challenge).toMatchObject({ revision: 3 });
    expect(registry.consume(first.code, "wrong-challenge")).toBeNull();
    const consumed = registry.consume(first.code, challenge!.challengeId);
    expect(consumed).toMatchObject({ nonce: challenge!.nonce, revision: 3 });
    expect(registry.beginChallenge(first.code, 3)).toBeNull();

    registry.issue();
    registry.issue();
    registry.issue();
    expect(registry.debugEntries()).toHaveLength(2);

    const late = registry.issue();
    now += 15 * 60_000 + 1;
    expect(registry.beginChallenge(late.code, 0)).toBeNull();
  });

  it("expires a challenge after two minutes", () => {
    let now = 0;
    const registry = new JoinCodeRegistry({ now: () => now });
    const { code } = registry.issue();
    const challenge = registry.beginChallenge(code, 0)!;
    now += 2 * 60_000 + 1;
    expect(registry.consume(code, challenge.challengeId)).toBeNull();
  });
});

describe("private network pairing", () => {
  let engine: Awaited<ReturnType<typeof createTestPGlite>>;
  let db: Kysely<PrivateNetworkDatabase>;
  let home: string;
  let now: number;

  beforeEach(async () => {
    engine = await createTestPGlite();
    db = new Kysely<PrivateNetworkDatabase>({ dialect: engine.dialect });
    await bootstrapPrivateNetworkDatabase(db);
    await bootstrapPrivateNetworkDatabase(db);
    home = await mkdtemp(join(tmpdir(), "matrix-pairing-"));
    now = Date.parse("2026-11-21T10:00:00Z");
    vi.stubEnv("MATRIX_USER_ID", OWNER);
    vi.stubEnv("MATRIX_HANDLE", "matrix");
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await db.destroy();
    await rm(home, { recursive: true, force: true });
  });

  function machine(id: string, dnsName = `${id}.tail1234.ts.net`) {
    return { machineId: id.padEnd(32, "0"), publicKey: "A".repeat(43), name: id, dnsName };
  }

  it("records pairings with a revision and rejects stale writers", async () => {
    const store = new PairingStore(db, () => new Date(now));
    expect(await store.list(OWNER)).toEqual({ revision: 0, machines: [] });
    const paired = await store.pair(OWNER, 0, machine("aa"));
    expect(paired.revision).toBe(1);
    await expect(store.pair(OWNER, 0, machine("bb"))).rejects.toMatchObject({ code: "stale" });
    const again = await store.pair(OWNER, 1, machine("aa"));
    expect(again.machines).toHaveLength(1);
    await expect(store.remove(OWNER, "bb".padEnd(32, "0"), 2)).rejects.toMatchObject({ code: "not_found" });
    expect((await store.list(OWNER)).revision).toBe(2);
    const removed = await store.remove(OWNER, "aa".padEnd(32, "0"), 2);
    expect(removed).toEqual({ revision: 3, machines: [] });
  });

  it("lists the revision and the machines from one consistent read when a pairing lands in between", async () => {
    const writer = new PairingStore(db, () => new Date(now));
    await writer.pair(OWNER, 0, machine("aa"));
    let armed = true;
    // Runs a concurrent pairing as soon as the first statement of list() has returned.
    const interleave: KyselyPlugin = {
      transformQuery: (args) => args.node,
      async transformResult(args) {
        if (armed) {
          armed = false;
          await writer.pair(OWNER, 1, machine("bb"));
        }
        return args.result;
      },
    };
    const reader = new PairingStore(db.withPlugin(interleave), () => new Date(now));
    const snapshot = await reader.list(OWNER);
    expect(armed).toBe(false);
    const consistent = [
      { revision: 1, ids: ["aa"] },
      { revision: 2, ids: ["aa", "bb"] },
    ];
    expect(consistent).toContainEqual({
      revision: snapshot.revision,
      ids: snapshot.machines.map((entry) => entry.name),
    });
    expect((await writer.list(OWNER)).revision).toBe(2);
  });

  it("replaces a reinstalled machine with the same tailnet name and caps the list", async () => {
    const store = new PairingStore(db, () => new Date(now), { maxMachines: 2 });
    await store.pair(OWNER, 0, machine("aa", "second.tail1234.ts.net"));
    const replaced = await store.pair(OWNER, 1, machine("cc", "second.tail1234.ts.net"));
    expect(replaced.machines.map((row) => row.machineId)).toEqual(["cc".padEnd(32, "0")]);
    await store.pair(OWNER, 2, machine("dd"));
    await expect(store.pair(OWNER, 3, machine("ee"))).rejects.toBeInstanceOf(PairingStoreError);
    expect((await store.list(OWNER)).revision).toBe(3);
  });

  const status = {
    BackendState: "Running",
    Self: { HostName: "primary", DNSName: "primary.tail1234.ts.net.", UserID: 1 },
    User: { "1": { LoginName: "alice@example.com" } },
    CurrentTailnet: { Name: "alice@example.com" },
    Peer: { a: { HostName: "second", DNSName: "second.tail1234.ts.net.", Online: true } },
  };

  function setup(options: { selfHosted?: boolean; tailnetScheme?: "http" | "https" | null } = {}) {
    const exec: TailscaleExec = vi.fn(async (args) => {
      if (args[0] === "status") return { stdout: JSON.stringify(status), stderr: "" };
      return { stdout: "", stderr: "" };
    });
    const tailscale = new TailscaleController({ exec, accessMode: "tailscale", loginServer: null, operator: "alice" });
    const ownerLogins = new OwnerLoginStore({ homePath: home, installLogin: "alice@example.com" });
    const joinCodes = new JoinCodeRegistry({ now: () => now });
    const app = new Hono();
    app.use("*", privateNetworkIdentityMiddleware({ accessMode: "tailscale", ownerLogin: () => ownerLogins.get(), remoteAddress: () => "127.0.0.1" }));
    app.use("*", authMiddleware(TOKEN));
    app.route("/api/system/private-network", createPrivateNetworkRoutes({
      config: {
        selfHosted: options.selfHosted ?? true, accessMode: "tailscale", loginServer: null, installOwnerLogin: "alice@example.com",
        runUser: "alice", updateChannel: "dev", ownerId: OWNER, machineId: "self-host-matrix", tailscaleBin: "/usr/bin/tailscale",
        tailnetScheme: options.tailnetScheme ?? null,
      },
      tailscale,
      ownerLogins,
      joinCodes,
      store: new PairingStore(db, () => new Date(now)),
      now: () => now,
    }));
    const request = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
      app.request(`http://127.0.0.1/api/system/private-network${path}`, {
        method,
        headers: { authorization: `Bearer ${TOKEN}`, "tailscale-user-login": "alice@example.com", ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    return { app, request, exec };
  }

  function secondMachine(): { privateKey: KeyObject; publicKey: string } {
    const pair = generateKeyPairSync("ed25519");
    return { privateKey: pair.privateKey, publicKey: createPublicKey(pair.privateKey).export({ format: "jwk" }).x! };
  }

  async function joinMachine(request: ReturnType<typeof setup>["request"], code: string, key = secondMachine(), dnsName = "second.tail1234.ts.net") {
    const challengeResponse = await request("POST", "/pairing/challenge", { joinCode: code });
    expect(challengeResponse.status).toBe(200);
    const challenge = await challengeResponse.json() as { challengeId: string; nonce: string; revision: number; ownerId: string; primaryMachineId: string };
    const signature = sign(null, Buffer.from(pairingMessage({ ...challenge, publicKey: key.publicKey, name: "second", dnsName }), "utf8"), key.privateKey).toString("base64url");
    return request("POST", "/pairing/complete", { joinCode: code, challengeId: challenge.challengeId, publicKey: key.publicKey, signature, name: "second", dnsName });
  }

  it("links to this machine over the scheme the installer served, such as HTTP without tailnet certificates", async () => {
    // Found on a live VPS: certificates were off, Matrix was served over tailnet
    // HTTP, but the join command pointed the second server at https.
    const { request } = setup({ tailnetScheme: "http" });
    expect(await (await request("GET", "")).json()).toMatchObject({ machine: { url: "http://primary.tail1234.ts.net" } });
    const issued = await (await request("POST", "/join-codes", {})).json() as { code: string; command: string };
    expect(issued.command).toContain("--join http://primary.tail1234.ts.net --join-code");
  });

  it("pairs a second machine end to end and lists it with live tailnet status", async () => {
    const { request } = setup();
    const statusResponse = await request("GET", "");
    expect(await statusResponse.json()).toMatchObject({
      supported: true, accessMode: "tailscale", state: "connected", tailnet: "alice@example.com", viaPrivateNetwork: true,
      machine: { name: "primary", dnsName: "primary.tail1234.ts.net", url: "https://primary.tail1234.ts.net" },
    });
    const codeResponse = await request("POST", "/join-codes", {});
    expect(codeResponse.status).toBe(201);
    const issued = await codeResponse.json() as { code: string; command: string; expiresAt: string };
    expect(issued.command).toBe(`curl -fsSL https://matrix-os.com/install-server.sh | sudo MATRIX_CHANNEL=dev bash -s -- --access tailscale --join https://primary.tail1234.ts.net --join-code ${issued.code}`);

    const completed = await joinMachine(request, issued.code);
    expect(completed.status).toBe(200);
    expect(await completed.json()).toMatchObject({ paired: true, primary: { name: "primary", dnsName: "primary.tail1234.ts.net" } });

    const machines = await (await request("GET", "/machines")).json() as { revision: number; machines: Array<Record<string, unknown>> };
    expect(machines.revision).toBe(1);
    expect(machines.machines).toEqual([expect.objectContaining({ name: "second", dnsName: "second.tail1234.ts.net", url: "https://second.tail1234.ts.net", online: true })]);

    const replay = await request("POST", "/pairing/challenge", { joinCode: issued.code });
    expect(replay.status).toBe(403);

    const removed = await request("DELETE", `/machines/${machines.machines[0]!.id as string}`, { revision: 1 });
    expect(await removed.json()).toEqual({ revision: 2, machines: [] });
  });

  it("rejects a bad signature, a machine that is not on the tailnet and a stale revision", async () => {
    const { request } = setup();
    const issue = async () => (await (await request("POST", "/join-codes", {})).json() as { code: string }).code;

    const code = await issue();
    const challenge = await (await request("POST", "/pairing/challenge", { joinCode: code })).json() as { challengeId: string };
    const forged = await request("POST", "/pairing/complete", { joinCode: code, challengeId: challenge.challengeId, publicKey: secondMachine().publicKey, signature: "A".repeat(86), name: "second", dnsName: "second.tail1234.ts.net" });
    expect(forged.status).toBe(403);

    const stranger = await joinMachine(request, await issue(), secondMachine(), "stranger.example.net");
    expect(stranger.status).toBe(403);

    const stale = await issue();
    const staleChallenge = await (await request("POST", "/pairing/challenge", { joinCode: stale })).json() as { challengeId: string; nonce: string; revision: number; ownerId: string; primaryMachineId: string };
    expect((await joinMachine(request, await issue())).status).toBe(200);
    const key = secondMachine();
    const signature = sign(null, Buffer.from(pairingMessage({ ...staleChallenge, publicKey: key.publicKey, name: "second", dnsName: "second.tail1234.ts.net" })), key.privateKey).toString("base64url");
    const late = await request("POST", "/pairing/complete", { joinCode: stale, challengeId: staleChallenge.challengeId, publicKey: key.publicKey, signature, name: "second", dnsName: "second.tail1234.ts.net" });
    expect(late.status).toBe(409);
    expect(await late.text()).not.toMatch(/revision|postgres|sql/i);
  });

  it("is owner-only, needs JSON bodies and is absent on managed computers", async () => {
    const { request, app } = setup();
    expect((await request("GET", "", undefined, { authorization: "Bearer wrong" })).status).toBe(401);
    const formPost = await app.request("http://127.0.0.1/api/system/private-network/join-codes", {
      method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "text/plain" }, body: "{}",
    });
    expect(formPost.status).toBe(415);
    expect((await request("POST", "/join-codes", { extra: true })).status).toBe(400);
    expect((await request("DELETE", "/machines/not-a-machine", { revision: 0 })).status).toBe(400);
    expect((await request("POST", "/disconnect", {})).status).toBe(400);

    const managed = setup({ selfHosted: false });
    expect(await (await managed.request("GET", "")).json()).toMatchObject({ supported: false, state: "unsupported" });
    expect((await managed.request("POST", "/join-codes", {})).status).toBe(404);
  });

  it("answers the nginx identity subrequest with 204 only for the owner", async () => {
    const { app } = setup();
    const owner = await app.request("http://127.0.0.1/api/system/private-network/identity", {
      headers: { authorization: `Bearer ${TOKEN}`, "tailscale-user-login": "alice@example.com" },
    });
    expect(owner.status).toBe(204);
    const missing = await app.request("http://127.0.0.1/api/system/private-network/identity", { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(missing.status).toBe(403);
    const foreign = await app.request("http://127.0.0.1/api/system/private-network/identity", {
      headers: { authorization: `Bearer ${TOKEN}`, "tailscale-user-login": "bob@example.com" },
    });
    expect(foreign.status).toBe(403);
  });
});

describe("private network runtime composition", () => {
  it("creates pairing tables only on private self-host installs and reports managed computers as unsupported", async () => {
    const { createPrivateNetworkRuntime } = await import("../../packages/gateway/src/server/private-network-runtime.js");
    const engine = await createTestPGlite();
    const db = new Kysely<PrivateNetworkDatabase>({ dialect: engine.dialect });
    const home = await mkdtemp(join(tmpdir(), "matrix-pn-runtime-"));
    try {
      const managed = await createPrivateNetworkRuntime({ env: {}, homePath: home, db: db as never });
      const app = new Hono();
      app.use("*", async (c, next) => { (await import("../../packages/gateway/src/request-principal.js")).markVerifiedRuntimeBearer(c); return next(); });
      app.route("/pn", managed.routes);
      expect(await (await app.request("/pn")).json()).toMatchObject({ supported: false, state: "unsupported" });
      const tables = async () => (await db.introspection.getTables()).map((table) => table.name).filter((name) => name.startsWith("private_network"));
      expect(await tables()).toEqual([]);
      managed.close();

      const selfHost = await createPrivateNetworkRuntime({
        env: { MATRIX_SELF_HOSTED: "1", MATRIX_ACCESS_MODE: "tailscale", MATRIX_RUNTIME_USER: "alice", MATRIX_TAILSCALE_BIN: "/nonexistent/tailscale" },
        homePath: home,
        db: db as never,
      });
      expect((await tables()).sort()).toEqual(["private_network_machines", "private_network_pairing_state", "private_network_schema_migrations"]);
      const selfHostApp = new Hono();
      selfHostApp.use("*", async (c, next) => { (await import("../../packages/gateway/src/request-principal.js")).markVerifiedRuntimeBearer(c); return next(); });
      selfHostApp.route("/pn", selfHost.routes);
      expect(await (await selfHostApp.request("/pn")).json()).toMatchObject({ supported: true, accessMode: "tailscale", state: "not-installed" });
      selfHost.close();
    } finally {
      await db.destroy();
      await rm(home, { recursive: true, force: true });
    }
  });
});
