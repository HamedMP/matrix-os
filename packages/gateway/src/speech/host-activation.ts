import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod/v4";
import { timingSafeStringEquals } from "../security/timing-safe.js";

const ConfigSchema = z.object({
  machineId: z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/),
  runtimeSlot: z.string().min(1).max(32).regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/),
  enabled: z.literal(true),
  origin: z.url({ protocol: /^https$/, hostname: z.regexes.hostname }),
  runtimeToken: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

function platformOrigin(env: NodeJS.ProcessEnv): string | null {
  try {
    const value = new URL(env.PLATFORM_INTERNAL_URL ?? "");
    if (value.protocol !== "https:" || value.username || value.password
      || value.pathname !== "/" || value.search || value.hash) return null;
    return value.origin;
  } catch (error: unknown) {
    if (!(error instanceof TypeError)) {
      console.warn("[gateway-speech] platform origin validation failed", error instanceof Error ? error.name : "UnknownError");
    }
    return null;
  }
}

function configurationRevision(env: NodeJS.ProcessEnv, origin: string | null): string | null {
  if (!(env.MATRIX_PLATFORM_SPEECH_ENABLED === "true" && origin !== null
    && env.MATRIX_PLATFORM_SPEECH_ORIGIN === origin
    && /^[a-f0-9]{64}$/.test(env.MATRIX_PLATFORM_SPEECH_RUNTIME_TOKEN ?? "")
    && Boolean(env.MATRIX_MACHINE_ID) && Boolean(env.MATRIX_RUNTIME_SLOT))) return null;
  return createHash("sha256").update(
    `${env.MATRIX_MACHINE_ID}\0${env.MATRIX_RUNTIME_SLOT}\0${origin}\0${env.MATRIX_PLATFORM_SPEECH_RUNTIME_TOKEN}`,
  ).digest("hex");
}

function runFixedCommand(command: string, args: string[], input?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: [input === undefined ? "ignore" : "pipe", "ignore", "ignore"] });
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Host speech command timed out"));
    }, 10_000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve();
      else reject(new Error("Host speech command failed"));
    });
    if (input !== undefined) child.stdin?.end(input);
  });
}

async function applyHostConfig(config: z.output<typeof ConfigSchema>): Promise<void> {
  await runFixedCommand(
    "/usr/bin/sudo",
    ["-n", "/opt/matrix/bin/matrix-configure-platform-speech.py"],
    JSON.stringify(config),
  );
}

async function scheduleGatewayRestart(): Promise<void> {
  const unit = `matrix-platform-speech-restart-${process.pid}-${Date.now()}`;
  await runFixedCommand("/usr/bin/sudo", [
    "-n", "/usr/bin/systemd-run", `--unit=${unit}`, "--collect", "--on-active=2s",
    "/usr/bin/systemctl", "restart", "matrix-gateway.service",
  ]);
}

export function createPlatformSpeechHostConfigRoutes(options: {
  env?: NodeJS.ProcessEnv;
  applyConfig?: (config: z.output<typeof ConfigSchema>) => Promise<void>;
  scheduleRestart?: () => Promise<void>;
} = {}): Hono {
  const env = options.env ?? process.env;
  const app = new Hono();
  const authorize = (authorization: string | undefined) => {
    const presented = authorization?.startsWith("Bearer ") ? authorization.slice(7) : null;
    const upgradeToken = env.UPGRADE_TOKEN;
    return upgradeToken !== undefined && timingSafeStringEquals(presented, upgradeToken);
  };

  app.get("/config", (c) => {
    if (!authorize(c.req.header("authorization"))) return c.json({ error: "Unauthorized" }, 401);
    const origin = platformOrigin(env);
    const revision = configurationRevision(env, origin);
    return c.json({ configured: revision !== null, configurationRevision: revision });
  });

  app.post("/config", bodyLimit({ maxSize: 4096 }), async (c) => {
    if (!authorize(c.req.header("authorization"))) return c.json({ error: "Unauthorized" }, 401);
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch (error: unknown) {
      if (!(error instanceof SyntaxError)) {
        console.warn("[gateway-speech] activation payload parse failed", error instanceof Error ? error.name : "UnknownError");
      }
      return c.json({ error: "Invalid request" }, 400);
    }
    const parsed = ConfigSchema.safeParse(raw);
    const origin = platformOrigin(env);
    if (!parsed.success || !origin || parsed.data.origin !== origin
      || parsed.data.machineId !== env.MATRIX_MACHINE_ID
      || parsed.data.runtimeSlot !== env.MATRIX_RUNTIME_SLOT) {
      return c.json({ error: "Invalid request" }, 400);
    }
    if (configurationRevision(env, origin) !== null
      && parsed.data.runtimeToken === env.MATRIX_PLATFORM_SPEECH_RUNTIME_TOKEN) {
      return c.json({ status: "configured" }, 200);
    }
    try {
      await (options.applyConfig ?? applyHostConfig)(parsed.data);
      await (options.scheduleRestart ?? scheduleGatewayRestart)();
      return c.json({ status: "restarting" }, 202);
    } catch (error: unknown) {
      console.warn("[gateway-speech] host activation failed", error instanceof Error ? error.name : "UnknownError");
      return c.json({ error: "Speech activation failed" }, 503);
    }
  });
  return app;
}
