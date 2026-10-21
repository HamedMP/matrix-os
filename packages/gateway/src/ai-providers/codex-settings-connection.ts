import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { buildAgentRuntimeEnvironment } from "../agent-launcher.js";
import { codexNativeEnvironment } from "./codex-native-environment.js";
import { resolveCodexNativeExecutable } from "./codex-native-terminal-command.js";
import { createCodexNativeAccountMetadataReader } from "./codex-native-account-metadata.js";
import { sameBoundNativeAccountPrincipal, verifyNativeAccountMetadata } from "./native-account-metadata-binding.js";
import { createCodexSettingsLogin } from "./provider-workflow-codex-login.js";
import { NativeProviderAdmissionNotStartedError, type NativeProviderProfileGuard } from "./native-provider-profile-guard.js";
import { ProviderWorkflowError, ProviderWorkflowNotStartedError } from "./provider-workflows.js";

const run = promisify(execFile);
// Official 0.156.1/0.162.1 public auth and transport were directly qualified.
// Retained official 0.163.0 generated schemas preserve the transitive public
// auth contract; this does not claim a fresh binary/transport or live login test.
// Other installed versions retain the independent official Terminal option.
const qualifiedVersions = ["codex-cli 0.156.1", "codex-cli 0.162.1", "codex-cli 0.163.0"];
export function createCodexSettingsConnection(options: { homePath: string; profileGuard: NativeProviderProfileGuard }) {
  const scope = () => {
    const base = buildAgentRuntimeEnvironment(options.homePath);
    const env = codexNativeEnvironment(options.homePath, base, process.env.CODEX_HOME);
    return { command: resolveCodexNativeExecutable(options.homePath, env), env };
  };
  const qualify = async (command: string, env: Record<string, string>) => {
    const result = await run(command, ["--version"], { cwd: options.homePath, env, encoding: "utf8", timeout: 5000, maxBuffer: 8192, windowsHide: true });
    if (!qualifiedVersions.includes(result.stdout.trim()) || result.stderr.trim()) throw new ProviderWorkflowNotStartedError();
  };
  return {
    async available() {
      try { const current = scope(); await qualify(current.command, current.env); return true; }
      catch (error) { console.warn("[provider-workflow] Codex Settings protocol unavailable:", error instanceof Error ? error.name : "UnknownError"); return false; }
    },
    async start(input: Parameters<ReturnType<typeof createCodexSettingsLogin>>[0]) {
      let current: ReturnType<typeof scope>;
      try { current = scope(); await qualify(current.command, current.env); }
      catch (error) {
        console.warn("[provider-workflow] Codex Settings protocol unavailable:", error instanceof Error ? error.name : "UnknownError");
        throw new ProviderWorkflowNotStartedError();
      }
      return createCodexSettingsLogin({ ...current, cwd: options.homePath,
        captureAccountProof: async spawnObserver => {
          // The login child has exited, but its writer lease is still ours.
          // Independently bind the effective native principal and file generation.
          let capturing = true;
          const reader = createCodexNativeAccountMetadataReader({ executable: current.command, cwd: options.homePath, environment: current.env,
            // Only capture owns the login writer. Later canonical mutation
            // verification keeps the existing read-only reader lifecycle.
            spawnProcess: (command, args, options) => capturing ? spawnObserver(command, args, options) : spawn(command, args, options) });
          try {
            const expected = await verifyNativeAccountMetadata(await reader());
            if (!expected || expected.authMethod !== "terminal") throw new ProviderWorkflowError("unavailable");
            return async observed => sameBoundNativeAccountPrincipal(expected, observed) && await verifyNativeAccountMetadata(expected) !== null;
          } finally { capturing = false; }
        }, acquire: async () => {
        let release: () => void | Promise<void>;
        try { release = await options.profileGuard.acquire("codex", { kind: "write", durable: true }); }
        catch (error) {
          if (error instanceof NativeProviderAdmissionNotStartedError) throw new ProviderWorkflowNotStartedError(error.reason === "busy" ? "conflict" : "unavailable");
          throw error;
        }
        try { await qualify(current.command, current.env); return release; }
        catch (error) { await release(); throw error; }
      } })(input);
    },
  };
}
