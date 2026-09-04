import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AgentProviderSummary } from "@matrix-os/contracts";
import {
  buildPiChildEnvironment,
  resolvePiCommand,
} from "../coding-agents/pi-process-environment.js";
import type { CodingModelCatalogProjection } from "./provider-catalog.js";

const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_MODELS = 64;
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_CACHE_TTL_MS = 60_000;
const SAFE_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,159}$/;
const PI_HEADER = ["provider", "model", "context", "max-out", "thinking", "images"];

export type NativeCodingModelCatalogRunCommand = (
  command: string,
  args: string[],
  options: { cwd: string; timeout: number; env: Record<string, string> },
) => Promise<{ stdout: string; stderr: string }>;

const execFileAsync = promisify(execFile);
const defaultRunCommand: NativeCodingModelCatalogRunCommand = async (command, args, options) => {
  const result = await execFileAsync(command, args, {
    ...options,
    encoding: "utf-8",
    maxBuffer: MAX_RESPONSE_BYTES,
  });
  return { stdout: result.stdout, stderr: result.stderr };
};

function boundedOutput(stdout: string, label: string): string[] {
  if (Buffer.byteLength(stdout, "utf-8") > MAX_RESPONSE_BYTES) {
    throw new Error(`${label} model catalog exceeded its response limit`);
  }
  return stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function modelProjection(input: {
  id: string;
  displayName: string;
  reasoning: boolean;
  vision: boolean;
}) {
  return {
    id: input.id,
    displayName: input.displayName,
    capabilities: [
      ...(input.reasoning ? ["reasoning" as const] : []),
      "tools" as const,
      ...(input.vision ? ["vision" as const] : []),
    ],
    supportsVision: input.vision,
    supportsToolUse: true,
  };
}

export function normalizePiModelCatalog(stdout: string): CodingModelCatalogProjection {
  const lines = boundedOutput(stdout, "Pi");
  const header = lines.shift()?.split(/\s+/).map((value) => value.toLowerCase());
  if (!header || header.length !== PI_HEADER.length
    || header.some((value, index) => value !== PI_HEADER[index])) {
    throw new Error("Pi model catalog is invalid");
  }
  const models = [];
  const seen = new Set<string>();
  for (const line of lines) {
    const columns = line.split(/\s+/);
    if (columns.length !== PI_HEADER.length) throw new Error("Pi model catalog is invalid");
    const [provider, model, _context, _maxOut, thinking, images] = columns;
    const id = `${provider}:${model}`;
    if (!SAFE_REFERENCE.test(provider!) || !SAFE_REFERENCE.test(model!) || !SAFE_REFERENCE.test(id)
      || !["yes", "no"].includes(thinking!) || !["yes", "no"].includes(images!)) {
      throw new Error("Pi model catalog is invalid");
    }
    if (seen.has(id)) continue;
    seen.add(id);
    models.push(modelProjection({
      id,
      displayName: model!,
      reasoning: thinking === "yes",
      vision: images === "yes",
    }));
    if (models.length === MAX_MODELS) break;
  }
  if (models.length === 0) throw new Error("Pi model catalog is empty");
  return { models, options: [], defaultModel: models[0]!.id };
}

export function normalizeOpenCodeModelCatalog(stdout: string): CodingModelCatalogProjection {
  const lines = boundedOutput(stdout, "OpenCode");
  const models = [];
  const seen = new Set<string>();
  for (const line of lines) {
    const separator = line.indexOf("/");
    if (separator <= 0 || separator === line.length - 1 || line.includes(" ")) {
      throw new Error("OpenCode model catalog is invalid");
    }
    const provider = line.slice(0, separator);
    const model = line.slice(separator + 1);
    const id = `${provider}:${model}`;
    if (!SAFE_REFERENCE.test(provider) || !SAFE_REFERENCE.test(model) || !SAFE_REFERENCE.test(id)) {
      throw new Error("OpenCode model catalog is invalid");
    }
    if (seen.has(id)) continue;
    seen.add(id);
    models.push(modelProjection({ id, displayName: model, reasoning: false, vision: false }));
    if (models.length === MAX_MODELS) break;
  }
  if (models.length === 0) throw new Error("OpenCode model catalog is empty");
  return { models, options: [], defaultModel: models[0]!.id };
}

export function createNativeCodingModelCatalogSource(options: {
  homePath: string;
  env?: Record<string, string>;
  piCommand?: string;
  openCodeCommand?: string;
  timeoutMs?: number;
  cacheTtlMs?: number;
  runCommand?: NativeCodingModelCatalogRunCommand;
}) {
  const timeoutMs = Math.max(1, Math.min(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, 30_000));
  const cacheTtlMs = Math.max(1, Math.min(options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS, 5 * 60_000));
  const runCommand = options.runCommand ?? defaultRunCommand;
  const cached = new Map<"pi" | "opencode", { expiresAt: number; value: CodingModelCatalogProjection }>();
  const pending = new Map<"pi" | "opencode", Promise<CodingModelCatalogProjection>>();

  return async (provider: AgentProviderSummary): Promise<CodingModelCatalogProjection | null> => {
    const kind = provider.kind === "pi" || provider.id === "pi"
      ? "pi" as const
      : provider.kind === "opencode" || provider.id === "opencode"
        ? "opencode" as const
        : null;
    if (kind === null || provider.availability !== "available") return null;
    const now = Date.now();
    const hit = cached.get(kind);
    if (hit && hit.expiresAt > now) return hit.value;
    const existing = pending.get(kind);
    if (existing) return existing;

    const env = buildPiChildEnvironment({ ...options.env, HOME: options.homePath });
    env.HOME = options.homePath;
    env.NO_COLOR = "1";
    const command = kind === "pi"
      ? resolvePiCommand(options.piCommand, env)
      : options.openCodeCommand ?? "opencode";
    const args = kind === "pi"
      ? [
          "--list-models",
          "--offline",
          "--no-extensions",
          "--no-skills",
          "--no-prompt-templates",
          "--no-context-files",
          "--no-approve",
        ]
      : ["models"];
    if (kind === "opencode") {
      env.OPENCODE_DISABLE_PROJECT_CONFIG = "1";
      env.OPENCODE_DISABLE_AUTOUPDATE = "1";
    }
    const request = runCommand(command, args, {
      cwd: options.homePath,
      timeout: timeoutMs,
      env,
    }).then(({ stdout }) => kind === "pi"
      ? normalizePiModelCatalog(stdout)
      : normalizeOpenCodeModelCatalog(stdout)).then((value) => {
      cached.set(kind, { expiresAt: Date.now() + cacheTtlMs, value });
      return value;
    }).finally(() => {
      pending.delete(kind);
    });
    pending.set(kind, request);
    return request;
  };
}
