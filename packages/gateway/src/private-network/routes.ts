/**
 * Self-host private network and machine pairing routes (spec 2701).
 *
 * Auth matrix: every route needs the owner bearer (`hasVerifiedRuntimeBearer`).
 * On Tailscale installs the bearer is injected by nginx only after its
 * auth_request to `/identity` succeeded, so a second machine reaches the pairing
 * routes over the tailnet as the owner's own node. Mutations need a JSON body
 * (`bodyLimit`, strict Zod schemas); CLI calls never take request values.
 */
import { createHash, createPublicKey, verify } from "node:crypto";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod/v4";
import { hasVerifiedRuntimeBearer } from "../request-principal.js";
import type { PrivateNetworkConfig } from "./config.js";
import { readPrivateNetworkIdentity, type OwnerLoginStore } from "./identity.js";
import { JOIN_CODE_PATTERN, type JoinCodeRegistry } from "./join-codes.js";
import { PairingStoreError, type PairingStore } from "./pairing-store.js";
import type { TailscaleController, TailscaleSnapshot, TailscaleState } from "./tailscale-cli.js";

const BODY_LIMIT = 4096;
const INSTALL_SCRIPT_URL = "https://matrix-os.com/install-server.sh";
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

const Empty = z.strictObject({});
const Disconnect = z.strictObject({ confirm: z.literal(true) });
const Remove = z.strictObject({ revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER) });
const MachineIdParam = z.string().regex(/^[a-f0-9]{32}$/);
const JoinCode = z.string().regex(JOIN_CODE_PATTERN);
const Challenge = z.strictObject({ joinCode: JoinCode });
const Complete = z.strictObject({
  joinCode: JoinCode,
  challengeId: z.uuid(),
  publicKey: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
  name: z.string().regex(/^[A-Za-z0-9-]{1,63}$/),
  dnsName: z.string().regex(/^[A-Za-z0-9-]{1,63}(\.[A-Za-z0-9-]{1,63}){0,8}$/).max(253),
});

export interface PrivateNetworkRouteOptions {
  config: PrivateNetworkConfig;
  tailscale: TailscaleController;
  ownerLogins: OwnerLoginStore;
  joinCodes: JoinCodeRegistry;
  /** Null when the owner database is unavailable: pairing routes answer 503. */
  store: PairingStore | null;
  now?: () => number;
}

export function pairingMessage(input: {
  primaryMachineId: string; ownerId: string; challengeId: string; nonce: string; revision: number;
  publicKey: string; name: string; dnsName: string;
}): string {
  return ["matrix-machine-pair-v1", input.primaryMachineId, input.ownerId, input.challengeId, input.nonce,
    String(input.revision), input.publicKey, input.name, input.dnsName].join("\n");
}

function machineIdFor(publicKey: string): string {
  return createHash("sha256").update(Buffer.from(publicKey, "base64url")).digest("hex").slice(0, 32);
}

function verifySignature(publicKey: string, message: string, signature: string): boolean {
  const raw = Buffer.from(publicKey, "base64url");
  if (raw.byteLength !== 32) return false;
  try {
    const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, raw]), format: "der", type: "spki" });
    return verify(null, Buffer.from(message, "utf8"), key, Buffer.from(signature, "base64url"));
  } catch (error: unknown) {
    // Malformed key material is a failed proof, not a server fault.
    if (error instanceof Error && "code" in error) return false;
    throw error;
  }
}

type JsonResult<T> = { ok: true; value: T } | { ok: false; response: Response };

async function readJson<T>(c: Context, schema: z.ZodType<T>): Promise<JsonResult<T>> {
  // JSON-only mutations: a cross-site form post cannot reach them without a CORS preflight.
  if (!/^application\/json(?:;|$)/i.test(c.req.header("content-type") ?? "")) {
    return { ok: false, response: c.json({ error: "Unsupported media type" }, 415) };
  }
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch (error: unknown) {
    if (error instanceof Error && error.name === "BodyLimitError") throw error;
    console.warn("[private-network] Invalid JSON body:", error instanceof SyntaxError ? "syntax" : "decode");
    return { ok: false, response: c.json({ error: "Invalid request" }, 400) };
  }
  const parsed = schema.safeParse(raw);
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false, response: c.json({ error: "Invalid request" }, 400) };
}

function machineUrl(config: PrivateNetworkConfig, dnsName: string): string {
  return `${config.accessMode === "headscale" ? "http" : "https"}://${dnsName}`;
}

export function createPrivateNetworkRoutes(options: PrivateNetworkRouteOptions): Hono {
  const { config, tailscale, ownerLogins, joinCodes } = options;
  const app = new Hono();
  const privateMode = config.selfHosted && (config.accessMode === "tailscale" || config.accessMode === "headscale");

  app.use("*", async (c, next) => {
    if (!hasVerifiedRuntimeBearer(c)) return c.json({ error: "Unauthorized" }, 401);
    c.header("Cache-Control", "no-store");
    return next();
  });
  app.use("*", bodyLimit({ maxSize: BODY_LIMIT, onError: (c) => c.json({ error: "Request too large" }, 413) }));

  const unsupported = (c: Context) => c.json({ error: "Not found" }, 404);
  const unavailable = (c: Context) => c.json({ error: "Private network is unavailable. Please try again later." }, 503);

  async function rememberOwner(snapshot: TailscaleSnapshot): Promise<void> {
    // This machine's own login is the owner's: only root, the operator or the owner's UI can sign it in.
    if (snapshot.state !== "connected" || !snapshot.ownerLogin) return;
    try {
      await ownerLogins.recordIfMissing(snapshot.ownerLogin);
    } catch (error: unknown) {
      console.error("[private-network] Recording the owner login failed:", error instanceof Error ? error.name : "unknown");
    }
  }

  function statusBody(c: Context, snapshot: TailscaleSnapshot, overrides: { state?: TailscaleState; loginUrl?: string | null } = {}) {
    const state = overrides.state ?? snapshot.state;
    const loginUrl = overrides.loginUrl !== undefined ? overrides.loginUrl
      : snapshot.authUrl && tailscale.isLoginUrl(snapshot.authUrl) ? snapshot.authUrl : null;
    return {
      supported: true,
      accessMode: config.accessMode,
      state,
      loginUrl: state === "needs-login" ? loginUrl : null,
      tailnet: state === "connected" ? snapshot.tailnet : null,
      machine: state === "connected" && snapshot.self
        ? { name: snapshot.self.name, dnsName: snapshot.self.dnsName, url: machineUrl(config, snapshot.self.dnsName) }
        : null,
      viaPrivateNetwork: readPrivateNetworkIdentity(c),
    };
  }

  async function recordedOwner(): Promise<string | null> {
    try {
      return await ownerLogins.get();
    } catch (error: unknown) {
      console.error("[private-network] Owner login unavailable:", error instanceof Error ? error.name : "unknown");
      return null;
    }
  }

  // nginx auth_request target: 204 only for the owner's private-network identity.
  app.get("/identity", async (c) => {
    if (!privateMode) return c.body(null, 403);
    if (readPrivateNetworkIdentity(c)) return c.body(null, 204);
    const presented = c.req.header("tailscale-user-login");
    if (!presented || (await recordedOwner())) return c.body(null, 403);
    // No owner recorded yet (signed in after install): learn it from this machine's own login once.
    await rememberOwner(await tailscale.status());
    const owner = await recordedOwner();
    return c.body(null, owner !== null && owner === presented ? 204 : 403);
  });

  app.get("/", async (c) => {
    if (!config.selfHosted) {
      return c.json({ supported: false, accessMode: null, state: "unsupported", loginUrl: null, tailnet: null, machine: null, viaPrivateNetwork: false });
    }
    const snapshot = await tailscale.status();
    await rememberOwner(snapshot);
    return c.json(statusBody(c, snapshot));
  });

  app.post("/connect", async (c) => {
    if (!config.selfHosted) return unsupported(c);
    const body = await readJson(c, Empty);
    if (!body.ok) return body.response;
    const result = await tailscale.connect();
    if (result.state === "unavailable") return unavailable(c);
    const snapshot = await tailscale.status();
    return c.json(statusBody(c, snapshot, result.state === "needs-login" ? { state: "needs-login", loginUrl: result.loginUrl } : {}));
  });

  app.post("/disconnect", async (c) => {
    if (!config.selfHosted) return unsupported(c);
    const body = await readJson(c, Disconnect);
    if (!body.ok) return body.response;
    try {
      await tailscale.disconnect();
    } catch (error: unknown) {
      console.error("[private-network] tailscale down failed:", error instanceof Error ? error.name : "unknown");
      return unavailable(c);
    }
    return c.json(statusBody(c, await tailscale.status()));
  });

  async function listMachines(c: Context) {
    if (!options.store || !config.ownerId) return unavailable(c);
    const [snapshot, network] = await Promise.all([options.store.list(config.ownerId), tailscale.status()]);
    const online = new Map(network.peers.map((peer) => [peer.dnsName, peer.online]));
    return c.json({
      revision: snapshot.revision,
      machines: snapshot.machines.map((machine) => ({
        id: machine.machineId,
        name: machine.name,
        dnsName: machine.dnsName,
        url: machineUrl(config, machine.dnsName),
        pairedAt: machine.pairedAt,
        online: network.state === "connected" ? (online.get(machine.dnsName) ?? false) : null,
      })),
    });
  }

  function storeFailure(c: Context, error: unknown) {
    if (error instanceof PairingStoreError) {
      if (error.code === "stale") return c.json({ error: "This list changed. Refresh and try again." }, 409);
      if (error.code === "capacity") return c.json({ error: "Too many paired machines." }, 409);
      return c.json({ error: "Not found" }, 404);
    }
    console.error("[private-network] Pairing store failed:", error instanceof Error ? error.name : "unknown");
    return unavailable(c);
  }

  app.get("/machines", async (c) => {
    if (!privateMode) return unsupported(c);
    try {
      return await listMachines(c);
    } catch (error: unknown) {
      return storeFailure(c, error);
    }
  });

  app.delete("/machines/:machineId", async (c) => {
    if (!privateMode) return unsupported(c);
    const id = MachineIdParam.safeParse(c.req.param("machineId"));
    if (!id.success) return c.json({ error: "Invalid request" }, 400);
    const body = await readJson(c, Remove);
    if (!body.ok) return body.response;
    if (!options.store || !config.ownerId) return unavailable(c);
    try {
      await options.store.remove(config.ownerId, id.data, body.value.revision);
      return await listMachines(c);
    } catch (error: unknown) {
      return storeFailure(c, error);
    }
  });

  app.post("/join-codes", async (c) => {
    if (!privateMode) return unsupported(c);
    const body = await readJson(c, Empty);
    if (!body.ok) return body.response;
    const network = await tailscale.status();
    if (network.state !== "connected" || !network.self) return c.json({ error: "Connect to your private network first." }, 409);
    const issued = joinCodes.issue();
    const primaryUrl = machineUrl(config, network.self.dnsName);
    const env = config.updateChannel ? `MATRIX_CHANNEL=${config.updateChannel} ` : "";
    const access = config.accessMode === "headscale" && config.loginServer
      ? `--access headscale --login-server ${config.loginServer}` : "--access tailscale";
    return c.json({
      code: issued.code,
      expiresAt: issued.expiresAt,
      command: `curl -fsSL ${INSTALL_SCRIPT_URL} | sudo ${env}bash -s -- ${access} --join ${primaryUrl} --join-code ${issued.code}`,
    }, 201);
  });

  // Called by the second machine's installer over the tailnet (owner's own node).
  app.post("/pairing/challenge", async (c) => {
    if (!privateMode) return unsupported(c);
    const body = await readJson(c, Challenge);
    if (!body.ok) return body.response;
    if (!options.store || !config.ownerId || !config.machineId) return unavailable(c);
    let revision: number;
    try {
      revision = (await options.store.list(config.ownerId)).revision;
    } catch (error: unknown) {
      return storeFailure(c, error);
    }
    const challenge = joinCodes.beginChallenge(body.value.joinCode, revision);
    if (!challenge) return c.json({ error: "This join code is not valid. Create a new one." }, 403);
    return c.json({ ...challenge, ownerId: config.ownerId, primaryMachineId: config.machineId });
  });

  app.post("/pairing/complete", async (c) => {
    if (!privateMode) return unsupported(c);
    const body = await readJson(c, Complete);
    if (!body.ok) return body.response;
    if (!options.store || !config.ownerId || !config.machineId) return unavailable(c);
    const input = body.value;
    const consumed = joinCodes.consume(input.joinCode, input.challengeId);
    const invalid = () => c.json({ error: "This join code is not valid. Create a new one." }, 403);
    if (!consumed) return invalid();
    const message = pairingMessage({
      primaryMachineId: config.machineId, ownerId: config.ownerId, challengeId: input.challengeId, nonce: consumed.nonce,
      revision: consumed.revision, publicKey: input.publicKey, name: input.name, dnsName: input.dnsName,
    });
    if (!verifySignature(input.publicKey, message, input.signature)) return invalid();
    const network = await tailscale.status();
    if (network.state !== "connected" || !network.self) return unavailable(c);
    if (!network.peers.some((peer) => peer.dnsName === input.dnsName)) return invalid();
    try {
      await options.store.pair(config.ownerId, consumed.revision, {
        machineId: machineIdFor(input.publicKey), publicKey: input.publicKey, name: input.name, dnsName: input.dnsName,
      });
    } catch (error: unknown) {
      return storeFailure(c, error);
    }
    return c.json({
      paired: true,
      machine: { id: machineIdFor(input.publicKey), name: input.name, dnsName: input.dnsName },
      primary: { name: network.self.name, dnsName: network.self.dnsName, url: machineUrl(config, network.self.dnsName) },
    });
  });

  return app;
}
