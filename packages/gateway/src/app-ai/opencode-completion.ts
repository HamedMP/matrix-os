import { execFile } from "node:child_process";
import { lstat, mkdtemp, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { AppAiResultSchema, type AiProviderSnapshotV3, type AppAiRoute, type AppAiRouteSelection, type ProviderSettingsSnapshot } from "@matrix-os/contracts";
import { createOpenCodeServerProcess } from "../coding-agents/opencode-server-process.js";
import { resolveOpenCodeCommand } from "../coding-agents/pi-process-environment.js";
import { buildIsolatedProviderLaunch } from "../coding-agents/provider-process-isolation.js";

const OPENCODE_FREE_SOURCE = "harness_opencode_opencode";
const CONTRACT_VERSION = "1.19.5";
const FreeModel = /^opencode:(?:big-pickle|[a-z0-9](?:[a-z0-9-]|(?<=[0-9])\.(?=[0-9])){0,95}-free)$/;
const execFileAsync = promisify(execFile);

export function isOpenCodeFreeAppRoute(route: AppAiRouteSelection): boolean {
  return route.accountId === null && route.accessSourceId === OPENCODE_FREE_SOURCE && FreeModel.test(route.modelId);
}

/** An installed guest route carries no Settings account and never inherits an API key. */
export function projectOpenCodeFreeAppRoutes(
  settings: ProviderSettingsSnapshot | undefined, canonical: AiProviderSnapshotV3 | undefined,
): Array<AppAiRoute & { modelLabel: string }> {
  if (!settings || !canonical?.drivers?.some(driver => driver.id === "opencode" && driver.installState === "installed")
    || canonical.nativeHarnessCatalog?.failures.includes("opencode")) return [];
  const configured = settings.harnesses.filter(harness => harness.harness === "opencode");
  if (configured.length > 1 || configured.some(harness => harness.enablementOrigin !== "generated_default" && !(harness.configuredEnabled ?? harness.enabled))) return [];
  const profile = canonical.nativeHarnessCatalog?.profiles.find(entry => entry.harness === "opencode" && entry.providerId === "opencode");
  return (profile?.models ?? []).filter(model => model.enabled && FreeModel.test(model.id)).map(model => ({
    harnessId: configured[0]?.id ?? "harness_opencode", accountId: null, accessSourceId: OPENCODE_FREE_SOURCE,
    modelId: model.id, displayName: "OpenCode Free", modelLabel: model.displayName,
    availability: "available", readiness: "local_profile", reason: null,
  }));
}

function sterileEnvironment(command: string, scratch: string): Record<string, string> {
  return {
    HOME: scratch, PATH: `${dirname(command)}:/usr/bin:/bin`,
    XDG_DATA_HOME: join(scratch, "data"), XDG_CONFIG_HOME: join(scratch, "config"),
    XDG_STATE_HOME: join(scratch, "state"), XDG_CACHE_HOME: join(scratch, "cache"), TMPDIR: scratch,
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CEILING_DIRECTORIES: "/tmp",
    OPENCODE_DISABLE_PROJECT_CONFIG: "1", OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
    OPENCODE_DISABLE_AUTOUPDATE: "1", OPENCODE_DISABLE_EXTERNAL_SKILLS: "1", OPENCODE_DISABLE_CLAUDE_CODE: "1",
    OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER: "1", OPENCODE_DISABLE_AUTOCOMPACT: "1",
    OPENCODE_PERMISSION: JSON.stringify({ "*": "deny" }), NO_COLOR: "1",
  };
}

/**
 * v1.19.5's built-in provider drops paid models when the isolated profile
 * has no key. Its LLM request filters tools using the verified session denies.
 * Custom providers, plugins, MCPs, CLI auth and owner worktrees stay outside.
 */
export function createOpenCodeAppCompletion() {
  const command = resolveOpenCodeCommand(undefined, undefined);
  let running = false;
  let pendingProbe: Promise<boolean> | undefined;
  let cached: { ready: boolean; expiresAt: number } | undefined;

  async function probeVersion(signal: AbortSignal): Promise<boolean> {
    if (process.platform !== "linux" || !buildIsolatedProviderLaunch({ command, args: [], env: {} }).isolated) return false;
    try {
      // Host-managed config takes precedence over the per-run config in v1.19.5.
      await lstat("/etc/opencode");
      return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
    }
    const scratch = await mkdtemp("/tmp/matrix-opencode-probe-");
    try {
      const { stdout } = await execFileAsync(command, ["--version"], {
        cwd: scratch, env: sterileEnvironment(command, scratch), signal, timeout: 3000, maxBuffer: 4096,
      });
      return stdout.trim() === CONTRACT_VERSION;
    } finally { await rm(scratch, { recursive: true, force: true }); }
  }

  async function probe(signal: AbortSignal): Promise<boolean> {
    signal.throwIfAborted();
    if (cached && cached.expiresAt > Date.now()) return cached.ready;
    pendingProbe ??= probeVersion(AbortSignal.timeout(3000)).catch(error => {
      console.warn("[app-ai] OpenCode runtime unavailable", error instanceof Error ? error.name : "UnknownError");
      return false;
    }).then(ready => {
      cached = { ready, expiresAt: Date.now() + 10_000 };
      return ready;
    }).finally(() => { pendingProbe = undefined; });
    const available = await pendingProbe;
    signal.throwIfAborted();
    return available;
  }

  async function generate(input: { modelId: string; prompt: string; signal: AbortSignal; revalidate(): Promise<boolean> }) {
    if (!FreeModel.test(input.modelId) || running) {
      console.warn("[app-ai] OpenCode completion unavailable", running ? "busy" : "model");
      throw new Error("OpenCode route is unavailable");
    }
    running = true;
    let scratch: string | undefined;
    let stage: "version" | "prepare" | "transport" = "version";
    try {
      if (!await probeVersion(input.signal)) throw new Error("OpenCode runtime is unavailable");
      stage = "prepare";
      scratch = await mkdtemp("/tmp/matrix-opencode-app-");
      const providerModel = input.modelId.slice("opencode:".length);
      const env = sterileEnvironment(command, scratch);
      env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
        enabled_providers: ["opencode"],
        provider: { opencode: { whitelist: [providerModel] } },
        snapshot: false, share: "disabled", permission: { "*": "deny" },
        agent: {
          build: { steps: 1, prompt: "Answer using only the supplied text. You have no tools or access to files." },
          title: { disable: true }, summary: { disable: true },
        },
      });
      input.signal.throwIfAborted();
      stage = "transport";
      const child = createOpenCodeServerProcess(command, ["run", "--model", `opencode/${providerModel}`, input.prompt], {
        cwd: scratch, env,
      }, { textOnly: { revalidate: input.revalidate } });
      const abort = () => child.kill("SIGTERM");
      input.signal.addEventListener("abort", abort, { once: true });
      try {
        const text = await new Promise<string>((resolve, reject) => {
          let result: string | undefined;
          child.stdout.on("data", chunk => {
            try {
              const event = JSON.parse(chunk.toString("utf8"));
              if (event.type === "text") result = AppAiResultSchema.parse({ text: event.part?.text }).text;
            } catch (error) {
              console.warn("[app-ai] OpenCode result unavailable", error instanceof Error ? error.name : "UnknownError");
              abort();
            }
          });
          child.once("exit", code => {
            if (code === 0 && result !== undefined) resolve(result);
            else reject(new Error("OpenCode response unavailable"));
          });
        });
        input.signal.throwIfAborted();
        return { text };
      } finally { input.signal.removeEventListener("abort", abort); }
    } catch (error) {
      console.warn("[app-ai] OpenCode completion unavailable", input.signal.aborted ? "aborted" : stage);
      throw error;
    } finally {
      try {
        if (scratch) await rm(scratch, { recursive: true, force: true });
      } finally { running = false; }
    }
  }

  return { probe, generate };
}
