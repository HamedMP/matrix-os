import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod/v4";
import { AgentConfigError } from "./errors.js";

const HOST_CONTROL_PATH = "/opt/matrix/bin/matrix-agent-runtime-control";
const MAX_CONTROL_OUTPUT_BYTES = 4_096;
const MAX_TOKEN_FILE_BYTES = 256;

const RuntimeIdSchema = z.enum(["hermes", "openclaw"]);
const RuntimeStatusSchema = z.object({
  installed: z.boolean(),
  running: z.boolean(),
}).strict();
const StatusResponseSchema = z.object({
  ok: z.literal(true),
  hermes: RuntimeStatusSchema,
  openclaw: RuntimeStatusSchema,
}).strict();
const MutationResponseSchema = z.object({
  ok: z.literal(true),
  runtime: RuntimeIdSchema,
}).strict();
const FailureResponseSchema = z.object({
  ok: z.literal(false),
  code: z.enum([
    "invalid_request",
    "runtime_unavailable",
    "auth_required",
    "resources_unavailable",
    "runtime_busy",
    "deactivation_failed",
    "activation_failed",
    "rollback_failed",
  ]),
}).strict();

interface ExecOptions {
  timeout: number;
  maxBuffer: number;
  signal: AbortSignal;
  windowsHide: boolean;
  encoding: "utf8";
}

type HostControlExecutor = (
  file: string,
  args: readonly string[],
  options: ExecOptions,
) => Promise<{ stdout: string; stderr: string }>;

export interface HostRuntimeStatus {
  hermes: { installed: boolean; running: boolean };
  openclaw: { installed: boolean; running: boolean };
}

export interface HostRuntimeControl {
  status(signal: AbortSignal): Promise<HostRuntimeStatus>;
  switch(runtime: z.infer<typeof RuntimeIdSchema>, signal: AbortSignal): Promise<void>;
  stop(runtime: z.infer<typeof RuntimeIdSchema>, signal: AbortSignal): Promise<void>;
}

function boundedText(value: unknown): string | null {
  if (typeof value === "string") {
    return Buffer.byteLength(value) <= MAX_CONTROL_OUTPUT_BYTES ? value : null;
  }
  if (Buffer.isBuffer(value) && value.byteLength <= MAX_CONTROL_OUTPUT_BYTES) {
    return value.toString("utf8");
  }
  return null;
}

function mapFailure(value: unknown): AgentConfigError {
  const error = value as { stdout?: unknown };
  const stdout = boundedText(error?.stdout);
  if (stdout !== null) {
    try {
      const parsed = FailureResponseSchema.safeParse(JSON.parse(stdout));
      if (parsed.success) {
        if (parsed.data.code === "runtime_busy") {
          return new AgentConfigError("agent_config_conflict");
        }
        if (["runtime_unavailable", "auth_required", "resources_unavailable"]
          .includes(parsed.data.code)) {
          return new AgentConfigError("runtime_unavailable");
        }
        if (parsed.data.code === "invalid_request") {
          return new AgentConfigError("agent_config_invalid");
        }
      }
    } catch (error) {
      if (!(error instanceof SyntaxError)) {
        console.warn(
          "[agent-config] Host failure response validation failed:",
          error instanceof Error ? error.name : "UnknownError",
        );
      }
      // Invalid host JSON is deliberately mapped without logging its content.
    }
  }
  return new AgentConfigError("runtime_switch_failed");
}

export function createHostRuntimeControl(options: {
  exec?: HostControlExecutor;
} = {}): HostRuntimeControl {
  const run = options.exec
    ?? promisify(execFile) as unknown as HostControlExecutor;

  async function execute(args: readonly string[], signal: AbortSignal) {
    try {
      return await run(HOST_CONTROL_PATH, args, {
        timeout: 70_000,
        maxBuffer: MAX_CONTROL_OUTPUT_BYTES,
        signal,
        windowsHide: true,
        encoding: "utf8",
      });
    } catch (error) {
      if (signal.aborted) throw error;
      throw mapFailure(error);
    }
  }

  async function mutate(
    operation: "switch" | "stop",
    runtime: z.infer<typeof RuntimeIdSchema>,
    signal: AbortSignal,
  ): Promise<void> {
    const id = RuntimeIdSchema.parse(runtime);
    const result = await execute([operation, id], signal);
    const stdout = boundedText(result.stdout);
    if (stdout === null) throw new AgentConfigError("invalid_response");
    try {
      const parsed = MutationResponseSchema.parse(JSON.parse(stdout));
      if (parsed.runtime !== id) throw new AgentConfigError("invalid_response");
    } catch (error) {
      if (error instanceof AgentConfigError) throw error;
      throw new AgentConfigError("invalid_response", error);
    }
  }

  return {
    async status(signal) {
      const result = await execute(["status"], signal);
      const stdout = boundedText(result.stdout);
      if (stdout === null) throw new AgentConfigError("invalid_response");
      try {
        const parsed = StatusResponseSchema.parse(JSON.parse(stdout));
        return { hermes: parsed.hermes, openclaw: parsed.openclaw };
      } catch (error) {
        throw new AgentConfigError("invalid_response", error);
      }
    },
    switch(runtime, signal) {
      return mutate("switch", runtime, signal);
    },
    stop(runtime, signal) {
      return mutate("stop", runtime, signal);
    },
  };
}

export async function readOpenClawGatewayToken(homePath: string): Promise<string> {
  const tokenPath = join(homePath, "system/agent-runtime/openclaw.env");
  let handle;
  try {
    handle = await open(tokenPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_TOKEN_FILE_BYTES || (stat.mode & 0o077) !== 0) {
      throw new AgentConfigError("agent_config_invalid");
    }
    const raw = await handle.readFile("utf8");
    const match = /^OPENCLAW_GATEWAY_TOKEN=([A-Fa-f0-9]{64})\n?$/.exec(raw);
    if (!match?.[1]) throw new AgentConfigError("agent_config_invalid");
    return match[1];
  } catch (error) {
    if (error instanceof AgentConfigError) throw error;
    throw new AgentConfigError("runtime_unavailable", error);
  } finally {
    await handle?.close().catch((error: unknown) => {
      console.warn(
        "[agent-config] OpenClaw token handle close failed:",
        error instanceof Error ? error.name : "UnknownError",
      );
    });
  }
}
