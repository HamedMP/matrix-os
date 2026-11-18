import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { AppAiInputSchema, AppAiRouteSelectionSchema, type AppAiRouteSelection } from "@matrix-os/contracts";
import { z } from "zod/v4";
import { createCodexCredentialFileProofReader } from "../ai-providers/codex-credential-file-proof.js";
import { codexNativeEnvironment } from "../ai-providers/codex-native-environment.js";
import type { NativeProviderProfileGuard } from "../ai-providers/native-provider-profile-guard.js";
import { readSavedProviderSettingsConfiguration } from "../ai-providers/provider-settings-persistence.js";
import { nativeCodexConfigurationFingerprint } from "../coding-agents/native-codex-configuration-fingerprint.mjs";
import { createNativeCodexExecutionProof } from "../coding-agents/native-codex-execution-proof.mjs";
import { HostedCodexTextError, runHostedCodexTextTurn, type HostedCodexRequest } from "./codex-profile-wire.js";

const BWRAP = "/usr/bin/bwrap";
const NODE_ROOT = "/opt/matrix/runtime/node";
const CODEX = `${NODE_ROOT}/bin/codex`;
const ISOLATED_HOME = "/home/matrix-codex";
const ISOLATED_PROFILE = `${ISOLATED_HOME}/.codex`;
const HOSTED_BOTS_CODEX_VERSION = "0.162.1";
const UNAVAILABLE = "Native Codex text completion unavailable";
// These keys are pinned to the Dev version. A model turn also gets no environment,
// integrations or dynamic tools, even when an individual feature is unsupported.
const DISABLED_FEATURES = [
  "shell_tool", "stable_environment_tools", "request_permissions_tool", "code_mode",
  "apps", "enable_mcp_apps", "hooks", "plugins", "plugin_hooks", "remote_plugin",
  "plugin_sharing", "tool_suggest", "multi_agent", "multi_agent_v2", "agent_message_board",
  "standalone_web_search", "browser_use", "browser_use_full_cdp_access", "browser_use_external",
  "computer_use", "image_generation", "view_image", "memories", "memory_tool",
  "auth_elicitation", "default_mode_request_user_input", "sleep_tool",
];
const execFileAsync = promisify(execFile);
const SafeConfig = z.object({
  config: z.object({
    cli_auth_credentials_store: z.literal("file"),
    forced_login_method: z.literal("chatgpt"),
    web_search: z.literal("disabled"),
    sandbox_mode: z.literal("read-only"),
    approval_policy: z.literal("never"),
    features: z.record(z.string(), z.unknown()),
    mcp_servers: z.record(z.string(), z.unknown()).optional(),
    plugins: z.record(z.string(), z.unknown()).optional(),
  }),
});

/** The child sees the system libraries, the native CLI, scratch space and a
 * read-only mount of the one owner credential file. It never sees owner config,
 * other credentials, the workspace, service sockets, or the Gateway environment. */
export function hostedCodexSandboxLaunch(authFile?: string) {
  return {
    command: BWRAP,
    env: {
      HOME: ISOLATED_HOME, CODEX_HOME: ISOLATED_PROFILE, PATH: `${NODE_ROOT}/bin:/usr/bin:/bin`,
      TMPDIR: "/tmp", LANG: "C.UTF-8",
    },
    args: [
      "--unshare-user", "--unshare-pid", "--unshare-ipc", "--unshare-uts",
      "--die-with-parent", "--new-session",
      "--ro-bind", "/usr", "/usr",
      "--ro-bind-try", "/bin", "/bin",
      "--ro-bind-try", "/lib", "/lib",
      "--ro-bind-try", "/lib64", "/lib64",
      "--ro-bind", NODE_ROOT, NODE_ROOT,
      "--ro-bind", "/etc/ssl/certs", "/etc/ssl/certs",
      "--ro-bind", "/etc/resolv.conf", "/etc/resolv.conf",
      "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", "--tmpfs", "/home",
      "--dir", ISOLATED_HOME, "--dir", ISOLATED_PROFILE, "--dir", "/work", "--chdir", "/work",
      ...(authFile ? ["--ro-bind", authFile, `${ISOLATED_PROFILE}/auth.json`] : []),
      "--", CODEX,
      ...(authFile ? [
        "-c", 'forced_login_method="chatgpt"', "-c", 'cli_auth_credentials_store="file"',
        "-c", 'model_provider="openai"', "-c", 'openai_base_url=""',
        "-c", 'chatgpt_base_url="https://chatgpt.com/backend-api/"',
        "-c", 'approval_policy="never"', "-c", 'sandbox_mode="read-only"',
        "-c", 'web_search="disabled"', "-c", "mcp_servers={}", "-c", "plugins={}",
        "-c", "tools.experimental_request_user_input.enabled=false", "-c", "tools.update_plan.enabled=false",
        "-c", "project_doc_max_bytes=0", "-c", "include_environment_context=false",
        ...DISABLED_FEATURES.flatMap(key => ["-c", `features.${key}=false`]),
        "app-server", "--stdio",
      ] : ["--version"]),
    ],
  };
}

async function assertNativeCodexSandbox(signal?: AbortSignal) {
  if (process.platform !== "linux" || !(await realpath(CODEX)).startsWith(`${NODE_ROOT}/`)) throw new Error(UNAVAILABLE);
  const launch = hostedCodexSandboxLaunch();
  const result = await execFileAsync(launch.command, launch.args, {
    signal, env: launch.env, timeout: 2_000, maxBuffer: 16_384, encoding: "utf8",
  });
  if (result.stdout.trim() !== `codex-cli ${HOSTED_BOTS_CODEX_VERSION}`) throw new Error(UNAVAILABLE);
}

export async function canCompleteCodexProfileAppText(homePath: string, signal?: AbortSignal): Promise<boolean> {
  try {
    await assertNativeCodexSandbox(signal);
    const environment = codexNativeEnvironment(homePath, {}, process.env.CODEX_HOME);
    return Boolean(await createCodexCredentialFileProofReader({ homePath, codexHome: environment.CODEX_HOME })());
  } catch (error) {
    signal?.throwIfAborted();
    if (!(error instanceof Error)) console.warn("[app-ai] Native Codex probe raised an unknown error");
    return false;
  }
}

export async function generateCodexProfileAppText(options: {
  homePath: string;
  route: AppAiRouteSelection;
  prompt: string;
  signal: AbortSignal;
  profileGuard: NativeProviderProfileGuard;
  revalidate: () => Promise<boolean>;
}) {
  let stage: "eligibility" | "launch" | "proof" | "turn" = "eligibility";
  try {
    const route = AppAiRouteSelectionSchema.parse(options.route);
    const { prompt } = AppAiInputSchema.parse({ prompt: options.prompt });
    if (route.accessSourceId !== "owner_openai_profile" || route.accountId !== "owner_codex") throw new Error(UNAVAILABLE);
    stage = "launch";
    await assertNativeCodexSandbox(options.signal);
    stage = "proof";
    const environment = codexNativeEnvironment(options.homePath, {}, process.env.CODEX_HOME);
    const config = await readSavedProviderSettingsConfiguration(join(environment.HOME!, "system/ai-providers/settings.json"));
    const rows = config?.harnesses.filter(row => row.harness === "codex") ?? [];
    const row = rows[0];
    if (rows.length !== 1 || !row?.enabled || row.id !== route.harnessId || row.driverId !== "codex"
      || row.accessSourceId !== route.accessSourceId || row.selectedAccountId !== route.accountId
      || row.route.kind !== "fixed" || row.route.providerId !== "openai"
      || !row.nativeAccountGeneration || row.nativeAccountConsentRevision === undefined) throw new Error(UNAVAILABLE);
    await options.profileGuard.assertReadable("codex");
    const prove = await createNativeCodexExecutionProof(row.nativeAccountGeneration, environment, {
      revision: row.nativeAccountConsentRevision, harnessInstanceId: row.id, accountId: route.accountId,
      configurationFingerprint: nativeCodexConfigurationFingerprint(row),
    });
    const authorize = async (request: HostedCodexRequest) => {
      options.signal.throwIfAborted();
      await options.profileGuard.assertReadable("codex");
      if (!await options.revalidate()) throw new Error(UNAVAILABLE);
      // Existing terminal consent proof uses a config/read scoped to the
      // process cwd. Scope that same check to the app-server's sterile cwd.
      await prove(async (method: string, params: unknown) => {
        if (method !== "config/read") return request(method, params);
        const value = await request(method, { cwd: "/work", includeLayers: false });
        const effective = SafeConfig.parse(value).config;
        if (Object.keys(effective.mcp_servers ?? {}).length || Object.keys(effective.plugins ?? {}).length
          || DISABLED_FEATURES.some(key => effective.features[key] !== false)) throw new Error(UNAVAILABLE);
        return value;
      });
      await options.profileGuard.assertReadable("codex");
      options.signal.throwIfAborted();
    };
    const launch = hostedCodexSandboxLaunch(join(environment.CODEX_HOME!, "auth.json"));
    stage = "turn";
    return await runHostedCodexTextTurn({ ...launch, model: route.modelId, prompt, signal: options.signal, authorize });
  } catch (error) {
    console.warn("[app-ai] Native Codex completion unavailable", error instanceof HostedCodexTextError ? error.stage : stage);
    throw new Error(UNAVAILABLE);
  }
}
