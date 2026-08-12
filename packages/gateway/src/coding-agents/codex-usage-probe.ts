import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { isAbsolute } from "node:path";
import {
  ProviderUsageSourceSummarySchema,
  SafeDisplayStringSchema,
  type ProviderUsageSourceSummary,
} from "@matrix-os/contracts";
import { z } from "zod/v4";
import { codexAppServerContractStatus } from "./codex-app-server-version.js";
import { CodexExecutableSchema } from "./codex-executable.js";
import { logCodingAgentWarning } from "./diagnostics.js";

const VERSION_TIMEOUT_MS = 5_000;
const APP_SERVER_TIMEOUT_MS = 5_000;
const MAX_LINE_BYTES = 64 * 1024;
const MAX_OUTPUT_BYTES = 256 * 1024;
const MAX_STDERR_BYTES = 8 * 1024;
const MAX_EPOCH_SECONDS = 4_102_444_800;

const DecimalBalanceSchema = z.string()
  .regex(/^(?:0|[1-9]\d{0,8})(?:\.\d{1,2})?$/);
const RateLimitWindowSchema = z.object({
  usedPercent: z.number().finite().min(0).max(100),
  windowDurationMins: z.number().int().min(1).max(525_600),
  resetsAt: z.number().int().min(0).max(MAX_EPOCH_SECONDS),
}).strict();
const RateLimitCreditsSchema = z.object({
  hasCredits: z.boolean(),
  unlimited: z.boolean(),
  balance: DecimalBalanceSchema.nullable(),
}).strict();
const CodexRateLimitsSchema = z.object({
  limitId: z.string().min(1).max(80).regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/),
  limitName: SafeDisplayStringSchema,
  primary: RateLimitWindowSchema.nullable(),
  secondary: RateLimitWindowSchema.nullable(),
  credits: RateLimitCreditsSchema.nullable(),
  individualLimit: z.unknown().nullable(),
  spendControlReached: z.boolean(),
  planType: z.string().min(1).max(80),
  rateLimitReachedType: z.string().min(1).max(80).nullable(),
}).strict();
const CodexRateLimitsReadResponseSchema = z.object({
  rateLimits: CodexRateLimitsSchema,
  rateLimitsByLimitId: z.unknown().nullable(),
  rateLimitResetCredits: z.unknown().nullable(),
}).strict();
const RpcResponseSchema = z.object({
  id: z.union([z.string().min(1).max(128), z.number().int().safe()]),
  result: z.unknown().optional(),
  error: z.unknown().optional(),
}).passthrough();
const CwdSchema = z.string().min(1).max(4096).refine(isAbsolute).regex(/^[^\u0000\r\n]+$/);
const EnvironmentSchema = z.record(
  z.string().min(1).max(256),
  z.string().max(32 * 1024),
).optional();

export interface CodexUsageProbeInput {
  signal: AbortSignal;
  now: () => Date;
}

export type CodexUsageProbe = (
  input: CodexUsageProbeInput,
) => Promise<ProviderUsageSourceSummary[]>;

export interface CodexUsageProbeOptions {
  command: string;
  cwd: string;
  env?: Record<string, string>;
  readRateLimits?: (signal: AbortSignal) => Promise<unknown>;
}

function windowLabel(windowMinutes: number): string {
  if (windowMinutes % 1_440 === 0) {
    const days = windowMinutes / 1_440;
    return `${days}-day window`;
  }
  if (windowMinutes % 60 === 0) {
    const hours = windowMinutes / 60;
    return `${hours}-hour window`;
  }
  return `${windowMinutes}-minute window`;
}

function normalizeWindow(
  id: "primary" | "secondary",
  value: z.infer<typeof RateLimitWindowSchema> | null,
) {
  if (value === null) return [];
  return [{
    id,
    label: windowLabel(value.windowDurationMins),
    remainingPercent: 100 - value.usedPercent,
    resetsAt: new Date(value.resetsAt * 1_000).toISOString(),
    windowMinutes: value.windowDurationMins,
  }];
}

export function normalizeCodexRateLimits(
  raw: unknown,
  observedAt: Date,
): ProviderUsageSourceSummary {
  const parsed = CodexRateLimitsReadResponseSchema.parse(raw);
  const windows = [
    ...normalizeWindow("primary", parsed.rateLimits.primary),
    ...normalizeWindow("secondary", parsed.rateLimits.secondary),
  ];
  const credits = parsed.rateLimits.credits;
  const normalizedCredits = credits?.hasCredits && !credits.unlimited && credits.balance !== null
    ? { remaining: Number(credits.balance), unit: "USD" }
    : undefined;
  if (windows.length === 0 && normalizedCredits === undefined) {
    throw new Error("Codex usage data is unavailable");
  }

  return ProviderUsageSourceSummarySchema.parse({
    id: "openai-chatgpt",
    displayName: "OpenAI / ChatGPT",
    linkedAgentProviderIds: ["codex"],
    state: "available",
    accuracy: "provider_reported",
    windows,
    ...(normalizedCredits === undefined ? {} : { credits: normalizedCredits }),
    observedAt: observedAt.toISOString(),
    setupActions: [],
  });
}

function genericError(): Error {
  return new Error("Codex usage is unavailable");
}

async function readVerifiedVersion(input: {
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
}): Promise<void> {
  const signal = AbortSignal.any([input.signal, AbortSignal.timeout(VERSION_TIMEOUT_MS)]);
  const output = await new Promise<string>((resolve, reject) => {
    execFile(input.command, ["--version"], {
      cwd: input.cwd,
      env: input.env,
      encoding: "utf8",
      maxBuffer: MAX_LINE_BYTES,
      timeout: VERSION_TIMEOUT_MS,
      signal,
    }, (error, stdout, stderr) => {
      if (error) {
        reject(genericError());
        return;
      }
      resolve(`${stdout}\n${stderr}`.slice(0, MAX_LINE_BYTES));
    });
  });
  if (codexAppServerContractStatus(output).status !== "verified") {
    throw genericError();
  }
}

async function readRateLimitsFromAppServer(input: {
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
}): Promise<unknown> {
  await readVerifiedVersion(input);
  const signal = AbortSignal.any([input.signal, AbortSignal.timeout(APP_SERVER_TIMEOUT_MS)]);
  return await new Promise<unknown>((resolve, reject) => {
    let settled = false;
    let stdoutBuffer = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let initialized = false;
    let forceKillTimer: NodeJS.Timeout | undefined;
    let child: ChildProcessWithoutNullStreams;

    const stopChild = () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill("SIGTERM");
      forceKillTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }, 250);
      forceKillTimer.unref();
    };
    const cleanup = () => {
      signal.removeEventListener("abort", onAbort);
    };
    const fail = () => {
      if (settled) return;
      settled = true;
      stopChild();
      cleanup();
      reject(genericError());
    };
    const succeed = (result: unknown) => {
      if (settled) return;
      settled = true;
      stopChild();
      cleanup();
      resolve(result);
    };
    const onAbort = () => fail();

    try {
      child = spawn(input.command, ["app-server", "--stdio"], {
        cwd: input.cwd,
        env: input.env,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      logCodingAgentWarning("Codex usage process spawn failed", err);
      reject(genericError());
      return;
    }

    signal.addEventListener("abort", onAbort, { once: true });
    child.once("error", fail);
    child.once("exit", () => {
      if (forceKillTimer) clearTimeout(forceKillTimer);
      if (!settled) fail();
    });
    child.stdin.once("error", fail);
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes = Math.min(MAX_STDERR_BYTES + 1, stderrBytes + chunk.byteLength);
      if (stderrBytes > MAX_STDERR_BYTES) fail();
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (settled) return;
      stdoutBytes += Buffer.byteLength(chunk, "utf8");
      if (stdoutBytes > MAX_OUTPUT_BYTES) {
        fail();
        return;
      }
      stdoutBuffer += chunk;
      if (Buffer.byteLength(stdoutBuffer, "utf8") > MAX_LINE_BYTES && !stdoutBuffer.includes("\n")) {
        fail();
        return;
      }
      while (stdoutBuffer.includes("\n")) {
        const newline = stdoutBuffer.indexOf("\n");
        const line = stdoutBuffer.slice(0, newline);
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        if (Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES) {
          fail();
          return;
        }
        let json: unknown;
        try {
          json = JSON.parse(line);
        } catch (err) {
          logCodingAgentWarning("Codex usage response parse failed", err);
          fail();
          return;
        }
        const response = RpcResponseSchema.safeParse(json);
        if (!response.success) continue;
        if (response.data.id === 1 && !initialized) {
          if (response.data.error !== undefined || response.data.result === undefined) {
            fail();
            return;
          }
          initialized = true;
          child.stdin.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`);
          child.stdin.write(`${JSON.stringify({ id: 2, method: "account/rateLimits/read" })}\n`);
          continue;
        }
        if (response.data.id === 2) {
          if (response.data.error !== undefined || response.data.result === undefined) {
            fail();
            return;
          }
          succeed(response.data.result);
          return;
        }
      }
    });

    if (signal.aborted) {
      fail();
      return;
    }
    child.stdin.write(`${JSON.stringify({
      id: 1,
      method: "initialize",
      params: {
        clientInfo: { name: "matrix-os", title: "Matrix OS", version: "1" },
        capabilities: { experimentalApi: true },
      },
    })}\n`);
  });
}

export function createCodexUsageProbe(options: CodexUsageProbeOptions): CodexUsageProbe {
  const command = CodexExecutableSchema.parse(options.command);
  const cwd = CwdSchema.parse(options.cwd);
  const configuredEnvironment = EnvironmentSchema.parse(options.env);
  const env = { ...process.env, ...configuredEnvironment };

  return async ({ signal, now }) => {
    try {
      const raw = options.readRateLimits
        ? await options.readRateLimits(signal)
        : await readRateLimitsFromAppServer({ command, cwd, env, signal });
      return [normalizeCodexRateLimits(raw, now())];
    } catch (err) {
      logCodingAgentWarning("Codex usage probe failed", err);
      throw genericError();
    }
  };
}
