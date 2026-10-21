import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  FundedHostActivationRequestSchema,
  FundedHostActivationResponseSchema,
  fundedHostActivationRevisionInput,
  type FundedHostActivationRequest,
  type FundedHostActivationResponse,
} from "@matrix-os/contracts";
import { timingSafeStringEquals } from "./security/timing-safe.js";

function loadedConfiguration(env: NodeJS.ProcessEnv): FundedHostActivationRequest | null {
  if (env.MATRIX_FUNDED_AI_ENABLED !== "true" || !env.MATRIX_RUNTIME_TOKEN_EPOCH) return null;
  const parsed = FundedHostActivationRequestSchema.safeParse({
    contractVersion: 1,
    identity: {
      handle: env.MATRIX_HANDLE,
      machineId: env.MATRIX_MACHINE_ID,
      ownerId: env.MATRIX_CLERK_USER_ID,
      runtimeSlot: env.MATRIX_RUNTIME_SLOT,
      runtimeTokenEpoch: Number(env.MATRIX_RUNTIME_TOKEN_EPOCH),
    },
    configuration: {
      enabled: true,
      platformOrigin: env.MATRIX_FUNDED_AI_PLATFORM_URL ?? env.PLATFORM_INTERNAL_URL,
      relayOrigin: env.MATRIX_FUNDED_AI_RELAY_URL,
      runtimeToken: env.MATRIX_FUNDED_AI_RUNTIME_TOKEN,
    },
  });
  return parsed.success ? parsed.data : null;
}

export function fundedHostConfigurationRevision(config: FundedHostActivationRequest): string {
  return createHash("sha256").update(fundedHostActivationRevisionInput(config)).digest("hex");
}

function run(command: string, args: string[], input?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: [input === undefined ? "ignore" : "pipe", "ignore", "ignore"] });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Host activation timed out"));
    }, 10_000);
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("close", code => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error("Host activation failed"));
    });
    child.stdin?.once("error", error => {
      child.kill("SIGKILL");
      clearTimeout(timer);
      reject(error);
    });
    if (input !== undefined) child.stdin?.end(input);
  });
}

async function applyHostConfig(config: FundedHostActivationResponse): Promise<void> {
  await run("/usr/bin/sudo", ["-n", "/opt/matrix/bin/matrix-configure-funded-ai.py"], JSON.stringify(config));
}

async function boundedJson(response: Response): Promise<unknown> {
  if (!response.ok || Number(response.headers.get("content-length") ?? "0") > 4096 || !response.body) {
    await response.body?.cancel();
    throw new Error("Activation proof unavailable");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.byteLength;
      if (length > 4096) {
        await reader.cancel();
        throw new Error("Activation proof too large");
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))) as unknown;
}

/** Operators request activation; only current read-only platform policy authorizes it. */
export function createPlatformFundedAiHostConfigRoutes(options: {
  env?: NodeJS.ProcessEnv;
  isIdle: () => boolean;
  fetch?: typeof fetch;
  now?: () => number;
  applyConfig?: (config: FundedHostActivationResponse) => Promise<void>;
  scheduleRestart: () => void | Promise<void>;
}): Hono {
  const env = options.env ?? process.env;
  const app = new Hono();
  const now = options.now ?? Date.now;
  let applying = false;
  const authorized = (authorization: string | undefined) => Boolean(env.UPGRADE_TOKEN)
    && timingSafeStringEquals(authorization?.startsWith("Bearer ") ? authorization.slice(7) : null, env.UPGRADE_TOKEN!);

  app.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store, private");
    await next();
  });
  app.get("/config", c => {
    if (!authorized(c.req.header("authorization"))) return c.json({ error: "Unauthorized" }, 401);
    const loaded = loadedConfiguration(env);
    return c.json({
      configured: loaded !== null,
      configurationRevision: loaded ? fundedHostConfigurationRevision(loaded) : null,
    });
  });
  app.post("/config", bodyLimit({ maxSize: 4096 }), async c => {
    if (!authorized(c.req.header("authorization"))) return c.json({ error: "Unauthorized" }, 401);
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch (error: unknown) {
      if (error instanceof Error && error.name === "BodyLimitError") return c.json({ error: "Request too large" }, 413);
      if (!(error instanceof SyntaxError)) {
        console.warn("[funded-host] request parse failed", error instanceof Error ? error.name : "UnknownError");
      }
      return c.json({ error: "Invalid request" }, 400);
    }
    const parsed = FundedHostActivationRequestSchema.safeParse(raw);
    if (!parsed.success) return c.json({ error: "Invalid request" }, 400);
    const { identity, configuration } = parsed.data;
    if (identity.handle !== env.MATRIX_HANDLE || identity.machineId !== env.MATRIX_MACHINE_ID
      || identity.ownerId !== env.MATRIX_CLERK_USER_ID || identity.runtimeSlot !== env.MATRIX_RUNTIME_SLOT
      || (env.MATRIX_RUNTIME_TOKEN_EPOCH !== undefined && String(identity.runtimeTokenEpoch) !== env.MATRIX_RUNTIME_TOKEN_EPOCH)) {
      return c.json({ error: "Invalid request" }, 400);
    }
    if (applying || !options.isIdle()) return c.json({ error: "Computer is busy" }, 409);
    applying = true;
    try {
      const url = new URL(`/internal/containers/${encodeURIComponent(identity.handle)}/ai/activation-config`, configuration.platformOrigin);
      url.searchParams.set("runtimeSlot", identity.runtimeSlot);
      const response = await (options.fetch ?? fetch)(url, {
        method: "GET",
        headers: { authorization: `Bearer ${configuration.runtimeToken}` },
        signal: AbortSignal.timeout(10_000),
        redirect: "error",
      });
      const proof = FundedHostActivationResponseSchema.parse(await boundedJson(response));
      const { issuedAt, expiresAt, ...proofRequest } = proof;
      if (Date.parse(issuedAt) > now() || Date.parse(expiresAt) <= now()
        || JSON.stringify(proofRequest) !== JSON.stringify(parsed.data)) {
        throw new Error("Activation proof mismatch");
      }
      if (!options.isIdle()) return c.json({ error: "Computer is busy" }, 409);
      const loaded = loadedConfiguration(env);
      if (loaded && fundedHostConfigurationRevision(loaded) === fundedHostConfigurationRevision(parsed.data)) {
        return c.json({ status: "configured" }, 200);
      }
      await (options.applyConfig ?? applyHostConfig)(proof);
      if (!options.isIdle()) return c.json({ error: "Computer is busy" }, 409);
      await options.scheduleRestart();
      return c.json({ status: "restarting" }, 202);
    } catch (error: unknown) {
      console.warn("[funded-host] activation failed", error instanceof Error ? error.name : "UnknownError");
      return c.json({ error: "AI activation failed" }, 503);
    } finally {
      applying = false;
    }
  });
  return app;
}
