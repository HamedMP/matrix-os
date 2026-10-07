import { NativeProviderWriteNotStartedError } from "./native-provider-profile-guard.js";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { isAbsolute, join } from "node:path";
import { ProviderWorkflowError } from "./provider-workflows.js";
import { createProviderKeyVerifier } from "./provider-workflow-key.js";

/** OpenClaw 2026.7.1 officially reads paste-api-key from piped stdin.
 * Other versions remain unavailable until their native protocol is verified.
 * OAuth login requires an interactive TTY in this pinned version.
 */
export function createOpenClawSettingsConnection(options: {
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  enableConnected: (harnessInstanceId: string, key: string) => Promise<void>;
  fetchFn?: typeof fetch;
  enableProviderConnected?: (harnessInstanceId: string, provider: "openai" | "anthropic" | "openrouter", key: string) => Promise<void>;
}) {
  if (!isAbsolute(options.command) || !isAbsolute(options.cwd)) throw new Error("Absolute native paths required");
  const env: NodeJS.ProcessEnv = { HOME: options.cwd, MATRIX_HOME: options.cwd, OPENCLAW_STATE_DIR: join(options.cwd, ".openclaw"), OPENCLAW_CONFIG_PATH: join(options.cwd, ".openclaw/openclaw.json") };
  for (const name of ["PATH", "LANG"]) {
    if (options.env[name]) env[name] = options.env[name];
  }
  let busy = false;
  let closed = false;
  const lifetime = new AbortController();
  let activeChild: ChildProcess | null = null;
  let activeReaped: Promise<void> = Promise.resolve();
  let probe: Promise<{ login: boolean; apiKey: boolean }> | null = null;
  let probeAt = 0;
  const discover = async () => {
    try {
      const read = promisify(execFile);
      const version = await read(options.command, ["--version"], { cwd: options.cwd, env, signal: lifetime.signal, killSignal: "SIGKILL", timeout: 10_000, maxBuffer: 4096 });
      if (!/^(?:OpenClaw )?2026\.7\.1(?: \([a-f0-9]{7,40}\))?$/.test(version.stdout.trim())) return { login: false, apiKey: false };
      const help = await read(options.command, ["models", "auth", "paste-api-key", "--help"], { cwd: options.cwd, env, signal: lifetime.signal, killSignal: "SIGKILL", timeout: 10_000, maxBuffer: 8192 });
      return { login: false, apiKey: /paste-api-key/.test(help.stdout) && /--provider/.test(help.stdout) && /--profile-id/.test(help.stdout) };
    } catch (error) {
      console.warn("[provider-workflow] OpenClaw auth capability unavailable:", error instanceof Error ? error.name : "UnknownError");
      return { login: false, apiKey: false };
    }
  };
  const capabilities = () => {
    if (closed) return Promise.resolve({ login: false, apiKey: false });
    if (!probe || Date.now() - probeAt > 30_000) {
      probeAt = Date.now();
      probe = discover();
    }
    return probe;
  };
  const save = async (key: string, provider = "openai") => {
    if (!(await capabilities()).apiKey) throw new NativeProviderWriteNotStartedError();
    if (busy || closed) throw new NativeProviderWriteNotStartedError();
    busy = true;
    await new Promise<void>((accept, reject) => {
      const child = spawn(options.command, ["models", "auth", "paste-api-key", "--provider", provider, "--profile-id", `${provider}:manual`], {
        cwd: options.cwd, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
      });
      activeChild = child;
      activeReaped = new Promise<void>(resolve => child.once("close", () => { activeChild = null; resolve(); }));
      let bytes = 0;
      let failed = false;
      const fail = () => { failed = true; child.kill("SIGKILL"); reject(new ProviderWorkflowError("unavailable")); };
      const timeout = setTimeout(fail, 15_000);
      // Drain and discard credential-bearing native diagnostics without buffering.
      const drain = (chunk: Buffer) => { bytes += chunk.byteLength; if (bytes > 65536) fail(); };
      child.stdout.on("data", drain); child.stderr.on("data", drain);
      child.stdin.on("error", fail);
      child.once("error", () => { clearTimeout(timeout); reject(new ProviderWorkflowError("unavailable")); });
      // Keep admission closed until the native process is actually reaped.
      child.once("close", code => { busy = false; clearTimeout(timeout); if (!closed && !failed && code === 0) accept(); else reject(new ProviderWorkflowError("unavailable")); });
      child.stdin.end(`${key}\n`);
    });
  };
  const verify = async (input: import("@matrix-os/contracts").ProviderWorkflowKey) => {
    if (input.providerId !== "openai" && !options.enableProviderConnected) throw new NativeProviderWriteNotStartedError();
    await createProviderKeyVerifier({ providerId: input.providerId, save: key => save(key, input.providerId), fetchFn: options.fetchFn })(input);
  };
  return {
    capabilities,
    async apiKeyProviders() { return (await capabilities()).apiKey ? options.enableProviderConnected ? ["openai", "anthropic", "openrouter"] as const : ["openai"] as const : []; },
    close: async () => {
      closed = true;
      lifetime.abort();
      activeChild?.kill("SIGKILL");
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([activeReaped, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new ProviderWorkflowError("unavailable")), 5000); })]);
      } finally { if (timer) clearTimeout(timer); }
    },
    verifyKey: async (input: Parameters<typeof verify>[0]) => {
      if (!(await capabilities()).apiKey) throw new NativeProviderWriteNotStartedError();
      await verify(input);
      if (closed) throw new ProviderWorkflowError("unavailable");
      if (options.enableProviderConnected) await options.enableProviderConnected(input.harnessInstanceId, input.providerId, `openclaw-key-${randomUUID()}`);
      else await options.enableConnected(input.harnessInstanceId, `openclaw-key-${randomUUID()}`);
    },
  };
}
