import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  ProviderAccessSourceSchema,
  ProviderModelProviderSchema,
  ProviderModelReferenceSchema,
  type ProviderAccessSource,
  type ProviderGenericHarnessKind,
  type ProviderModelProvider,
} from "@matrix-os/contracts";
import { buildAgentRuntimeEnvironment } from "../agent-launcher.js";
import {
  buildPiChildEnvironment,
  resolvePiCommand,
} from "../coding-agents/pi-process-environment.js";

const COMMAND_TIMEOUT_MS = 5_000;
const MAX_OUTPUT_BYTES = 256 * 1024;
const MAX_MODELS_PER_HARNESS = 256;
const MAX_MODELS_PER_PROVIDER = 256;
const MAX_DISCOVERED_PROVIDERS = 24;
const CACHE_TTL_MS = 60_000;

export interface GenericHarnessModelRoute {
  providerId: string;
  providerDisplayName: string;
  modelId: string;
  modelDisplayName: string;
}

export interface GenericHarnessModelCatalog {
  providers: ProviderModelProvider[];
  accessSources: ProviderAccessSource[];
  failures: Array<Extract<ProviderGenericHarnessKind, "pi" | "opencode">>;
}

type CodingHarness = Extract<ProviderGenericHarnessKind, "pi" | "opencode">;
type RunCommand = (
  command: string,
  args: string[],
  options: {
    cwd: string;
    timeoutMs: number;
    maxOutputBytes: number;
    env: Record<string, string>;
  },
) => Promise<{ stdout: string; stderr: string }>;

const execFileAsync = promisify(execFile);
const defaultRun: RunCommand = async (command, args, options) => {
  const result = await execFileAsync(command, args, {
    cwd: options.cwd,
    timeout: options.timeoutMs,
    killSignal: "SIGKILL",
    maxBuffer: options.maxOutputBytes,
    encoding: "utf8",
    env: options.env,
    windowsHide: true,
  });
  return { stdout: result.stdout, stderr: result.stderr };
};

function providerId(slug: string): string | null {
  const value = slug.toLowerCase().replace(/[^a-z0-9_.:-]/g, "_").slice(0, 96);
  return /^[a-z0-9][a-z0-9_.:-]{0,95}$/.test(value) && !value.includes("..") ? value : null;
}

function words(value: string): string[] {
  return value.split(/[-_\s]+/).filter(Boolean);
}

function displayWord(value: string): string {
  const lower = value.toLowerCase();
  if (lower === "ai") return "AI";
  if (lower === "api") return "API";
  if (lower === "glm") return "GLM";
  if (lower === "gpt") return "GPT";
  if (lower === "openai") return "OpenAI";
  if (lower === "opencode") return "OpenCode";
  if (lower === "deepseek") return "DeepSeek";
  if (/^v?\d+(?:\.\d+)*$/i.test(value)) return value.toUpperCase();
  return value.slice(0, 1).toUpperCase() + value.slice(1);
}

function providerDisplayName(slug: string): string {
  if (slug === "zai-coding-plan") return "Z.AI Coding Plan";
  return words(slug).map(displayWord).join(" ");
}

function modelDisplayName(slug: string): string {
  const leaf = slug.split("/").at(-1) ?? slug;
  const parts = words(leaf);
  if ((parts[0]?.toLowerCase() === "gpt" || parts[0]?.toLowerCase() === "glm")
    && /^\d/.test(parts[1] ?? "")) {
    return `${displayWord(parts[0]!)}-${parts[1]}${parts.slice(2).map((part) => ` ${displayWord(part)}`).join("")}`
      .slice(0, 120);
  }
  return parts.map(displayWord).join(" ").slice(0, 120);
}

function route(providerSlug: string, modelSlug: string): GenericHarnessModelRoute | null {
  const normalizedProvider = providerId(providerSlug);
  const modelId = `${providerSlug}:${modelSlug}`;
  if (normalizedProvider === null || !ProviderModelReferenceSchema.safeParse(modelId).success) return null;
  const providerName = providerDisplayName(providerSlug);
  const modelName = modelDisplayName(modelSlug);
  if (!providerName || !modelName) return null;
  const candidate = {
    providerId: normalizedProvider,
    providerDisplayName: providerName,
    modelId,
    modelDisplayName: modelName,
  };
  return ProviderModelProviderSchema.safeParse({
    id: candidate.providerId,
    displayName: candidate.providerDisplayName,
    models: [{ id: candidate.modelId, displayName: candidate.modelDisplayName, enabled: true }],
  }).success ? candidate : null;
}

export function parsePiModelCatalog(output: string): GenericHarnessModelRoute[] {
  const routes: GenericHarnessModelRoute[] = [];
  for (const raw of output.split(/\r?\n/)) {
    const columns = raw.trim().split(/\s+/);
    if (columns.length < 2 || columns[0] === "provider") continue;
    const candidate = route(columns[0]!, columns[1]!);
    if (candidate) routes.push(candidate);
    if (routes.length >= MAX_MODELS_PER_HARNESS) break;
  }
  return routes;
}

export function parseOpenCodeModelCatalog(output: string): GenericHarnessModelRoute[] {
  const routes: GenericHarnessModelRoute[] = [];
  for (const raw of output.split(/\r?\n/)) {
    const value = raw.trim();
    const separator = value.indexOf("/");
    if (separator < 1 || separator === value.length - 1 || /\s/.test(value)) continue;
    const candidate = route(value.slice(0, separator), value.slice(separator + 1));
    if (candidate) routes.push(candidate);
    if (routes.length >= MAX_MODELS_PER_HARNESS) break;
  }
  return routes;
}

function mergeProviders(routes: readonly GenericHarnessModelRoute[]): ProviderModelProvider[] {
  const providers = new Map<string, ProviderModelProvider>();
  for (const item of routes) {
    if (!providers.has(item.providerId) && providers.size >= MAX_DISCOVERED_PROVIDERS) continue;
    const provider = providers.get(item.providerId) ?? {
      id: item.providerId,
      displayName: item.providerDisplayName,
      models: [],
    };
    if (provider.models.length < MAX_MODELS_PER_PROVIDER
      && !provider.models.some((model) => model.id === item.modelId)) {
      provider.models.push({ id: item.modelId, displayName: item.modelDisplayName, enabled: true });
    }
    providers.set(item.providerId, provider);
  }
  return [...providers.values()]
    .map((provider) => ProviderModelProviderSchema.parse(provider))
    .sort((left, right) => left.displayName.localeCompare(right.displayName));
}

function projectSource(
  harness: CodingHarness,
  provider: ProviderModelProvider,
  now: Date,
): ProviderAccessSource {
  const checkedAt = now.toISOString();
  const staleAfter = new Date(now.getTime() + 5 * 60_000).toISOString();
  return ProviderAccessSourceSchema.parse({
    id: `harness_${harness}_${provider.id}`,
    kind: "harness_profile",
    harness,
    fundingKind: "owner_account",
    providerId: provider.id,
    accountId: null,
    displayName: `${harness === "pi" ? "Pi" : "OpenCode"} account`,
    readiness: {
      state: "ready",
      checkedAt,
      staleAfter,
      action: "none",
      safeReason: null,
    },
    eligibleModelIds: provider.models.map((model) => model.id),
    usage: {
      kind: "unavailable",
      authority: "unavailable",
      state: "not_applicable",
      scope: "access_source",
      reason: "provider_does_not_report",
      asOf: checkedAt,
    },
  });
}

export function createGenericHarnessModelCatalogReader(options: {
  homePath: string;
  enabledHarnesses: readonly CodingHarness[];
  run?: RunCommand;
  now?: () => Date;
}) {
  if (!options.homePath) throw new Error("Generic harness catalog home path is required");
  const enabled = [...new Set(options.enabledHarnesses)].filter(
    (harness): harness is CodingHarness => harness === "pi" || harness === "opencode",
  );
  const run = options.run ?? defaultRun;
  const now = options.now ?? (() => new Date());
  let cached: { expiresAt: number; value: GenericHarnessModelCatalog } | null = null;

  return {
    async getCatalog(input: { refresh?: boolean } = {}): Promise<GenericHarnessModelCatalog> {
      const currentTime = now();
      if (!input.refresh && cached && cached.expiresAt > currentTime.getTime()) return cached.value;
      const runtimeEnv = buildAgentRuntimeEnvironment(options.homePath);
      const env = buildPiChildEnvironment(runtimeEnv);
      const results = await Promise.allSettled(enabled.map(async (harness) => {
        const command = harness === "pi" ? resolvePiCommand(undefined, env) : "opencode";
        const args = harness === "pi" ? [
          "--list-models", "--offline", "--no-extensions", "--no-skills",
          "--no-prompt-templates", "--no-context-files", "--no-approve",
        ] : ["models"];
        const result = await run(command, args, {
          cwd: options.homePath,
          timeoutMs: COMMAND_TIMEOUT_MS,
          maxOutputBytes: MAX_OUTPUT_BYTES,
          env: harness === "opencode" ? {
            ...env, OPENCODE_DISABLE_PROJECT_CONFIG: "1", OPENCODE_DISABLE_AUTOUPDATE: "1",
          } : env,
        });
        return {
          harness,
          routes: harness === "pi"
            ? parsePiModelCatalog(result.stdout)
            : parseOpenCodeModelCatalog(result.stdout),
        };
      }));
      const failures: CodingHarness[] = [];
      const perHarness = new Map<CodingHarness, ProviderModelProvider[]>();
      for (let index = 0; index < results.length; index += 1) {
        const result = results[index]!;
        const harness = enabled[index]!;
        if (result.status === "rejected" || result.value.routes.length === 0) {
          console.warn(`[provider-settings] ${harness} model catalog unavailable`);
          failures.push(harness);
          continue;
        }
        perHarness.set(harness, mergeProviders(result.value.routes));
      }
      const providers = mergeProviders([...perHarness.values()].flat().flatMap((provider) =>
        provider.models.map((model) => ({
          providerId: provider.id,
          providerDisplayName: provider.displayName,
          modelId: model.id,
          modelDisplayName: model.displayName,
        }))));
      const accessSources = [...perHarness].flatMap(([harness, harnessProviders]) =>
        harnessProviders.map((provider) => projectSource(harness, provider, currentTime)));
      const value = { providers, accessSources, failures };
      cached = { expiresAt: currentTime.getTime() + CACHE_TTL_MS, value };
      return value;
    },
  };
}

export type GenericHarnessModelCatalogReader = ReturnType<typeof createGenericHarnessModelCatalogReader>;
