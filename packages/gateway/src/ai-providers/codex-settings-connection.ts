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
// Retained official 0.163.0/0.164.0 generated schemas preserve the transitive
// public auth contract; 0.164.0 only adds two plan enum values. This does not
// claim a fresh binary/transport or live login test. The retained 0.171.0
// schema only adds an optional capability, optional account metadata and a
// gcp account kind the bounded account reader rejects.
// Other installed versions retain the independent official Terminal option.
const qualifiedVersions = ["codex-cli 0.156.1", "codex-cli 0.162.1", "codex-cli 0.163.0", "codex-cli 0.164.0", "codex-cli 0.171.0"];

type QualificationFailure = "scope_unavailable" | "version_process_failed" | "unsupported_version" | "unexpected_stderr";

function reportQualificationFailure(reason: QualificationFailure, error: unknown, stdout?: unknown): { error: unknown } {
  // The CLI may emit account details or other arbitrary text. Only a standard
  // bounded numeric release version belongs in the diagnostic.
  const version = typeof stdout === "string" ? /^codex-cli (\d{1,6}\.\d{1,6}\.\d{1,6})$/.exec(stdout.trim())?.[1] : undefined;
  console.warn("[provider-workflow] Codex Settings protocol unavailable:", reason, version ?? "unknown_version");
  return { error };
}

export function createCodexSettingsConnection(options: { homePath: string; profileGuard: NativeProviderProfileGuard }) {
  const checkVersion = async ({ command, env }: { command: string; env: Record<string, string> }) => {
    let result;
    try {
      result = await run(command, ["--version"], { cwd: options.homePath, env, encoding: "utf8", timeout: 5000, maxBuffer: 8192, windowsHide: true });
    } catch (error) {
      const stdout = error instanceof Error && "stdout" in error ? error.stdout : undefined;
      return reportQualificationFailure("version_process_failed", error, stdout);
    }
    const stderrPresent = Boolean(result.stderr.trim());
    if (!stderrPresent && qualifiedVersions.includes(result.stdout.trim())) return null;
    return reportQualificationFailure(stderrPresent ? "unexpected_stderr" : "unsupported_version", new ProviderWorkflowNotStartedError(), result.stdout);
  };

  const qualifyScope = async () => {
    let current;
    try {
      const base = buildAgentRuntimeEnvironment(options.homePath);
      const env = codexNativeEnvironment(options.homePath, base, process.env.CODEX_HOME);
      current = { command: resolveCodexNativeExecutable(options.homePath, env), env };
    } catch (error) {
      return reportQualificationFailure("scope_unavailable", error);
    }
    return await checkVersion(current) ?? current;
  };

  return {
    async available() {
      return !("error" in await qualifyScope());
    },
    async start(input: Parameters<ReturnType<typeof createCodexSettingsLogin>>[0]) {
      const current = await qualifyScope();
      if ("error" in current) throw new ProviderWorkflowNotStartedError();
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
        try {
          const failure = await checkVersion(current);
          if (failure) throw failure.error;
          return release;
        } catch (error) {
          await release();
          throw error;
        }
      } })(input);
    },
  };
}
