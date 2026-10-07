import { NativeProviderWriteNotStartedError } from "./native-provider-profile-guard.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { spawnIsolatedProviderProcess } from "../coding-agents/provider-process-isolation.js";
import { buildAgentRuntimeEnvironment } from "../agent-launcher.js";
import { createProviderKeyVerifier } from "./provider-workflow-key.js";
import { ProviderWorkflowError } from "./provider-workflows.js";
import type { ProviderWorkflowKey } from "@matrix-os/contracts";

/** Sanctioned native credential lifecycle. Missing helpers are an unsupported runtime, not a guessed file format. */
export const HERMES_SETTINGS_KEY_WORKER = `
import sys, os, json
out = os.dup(1)
sys.stdout = open(os.devnull, "w")
sys.stderr = open(os.devnull, "w")
os.dup2(sys.stdout.fileno(), 1)
os.dup2(sys.stderr.fileno(), 2)
try:
    from hermes_cli.config import save_env_value_secure, require_env_writable, get_env_value
    if not all(callable(fn) for fn in [save_env_value_secure, require_env_writable, get_env_value]): sys.exit(2)
    if sys.argv[1] == "probe":
        os.write(out, b'{"supported":true}\\n')
    else:
        raw = sys.stdin.read(8193)
        if len(raw.encode("utf8")) > 8192: sys.exit(2)
        value = json.loads(raw)
        names = {"openai":"OPENAI_API_KEY", "anthropic":"ANTHROPIC_API_KEY", "openrouter":"OPENROUTER_API_KEY"}
        name = names[value["provider"]]
        key = value["key"]
        if not isinstance(key, str) or not key or len(key) > 4096: sys.exit(2)
        require_env_writable(name, "set")
        result = save_env_value_secure(name, key)
        if not isinstance(result, dict) or result.get("success") is not True or get_env_value(name) != key: sys.exit(1)
except Exception:
    sys.exit(1)
finally:
    os.close(out)
`;
export function createHermesSettingsConnection(options: {
  homePath: string;
  enableConnected: (id: string, provider: "openai-api" | "anthropic" | "openrouter", key: string) => Promise<void>;
  fetchFn?: typeof fetch;
}) {
  const home = resolve(options.homePath); const installation = join(home, ".hermes/hermes-agent");
  const command = join(installation, "venv/bin/python");
  const env = { ...buildAgentRuntimeEnvironment(home), HERMES_HOME: join(home, ".hermes") };
  let closed = false; let busy = false; let active: ReturnType<typeof spawnIsolatedProviderProcess> | undefined;
  let drained: Promise<void> = Promise.resolve();
  let committing: Promise<void> | undefined;
  let cached: { at: number; supported: boolean } | undefined; let probing: Promise<boolean> | undefined;
  const supported = async () => {
    if (closed) return false;
    if (cached && Date.now() - cached.at < 15000) return cached.supported;
    probing ??= (async () => {
      try {
        const result = await promisify(execFile)(command, ["-c", HERMES_SETTINGS_KEY_WORKER, "probe"], { cwd: installation, env, timeout: 10000, maxBuffer: 4096, windowsHide: true });
        const value = result.stdout.trim() === '{"supported":true}'; cached = { at: Date.now(), supported: value }; return value;
      } catch (error) { console.warn("[provider-workflow] Hermes key capability unavailable:", error instanceof Error ? error.name : "UnknownError"); cached = { at: Date.now(), supported: false }; return false; }
    })();
    try { return await probing; } finally { probing = undefined; }
  };
  const save = async (input: ProviderWorkflowKey) => {
    if (closed || busy || !(await supported())) throw new NativeProviderWriteNotStartedError();
    if (closed || busy) throw new NativeProviderWriteNotStartedError();
    busy = true;
    await new Promise<void>((accept, reject) => {
      let child: ReturnType<typeof spawnIsolatedProviderProcess>;
      try { child = spawnIsolatedProviderProcess(command, ["-c", HERMES_SETTINGS_KEY_WORKER, "key"], { cwd: installation, env, stdio: ["pipe", "pipe", "pipe"] }); }
      catch (error) { busy = false; reject(new ProviderWorkflowError("unavailable")); return; }
      active = child; drained = new Promise<void>(resolve => child.once("close", () => { active = undefined; busy = false; resolve(); }));
      let failure = false; let bytes = 0;
      const fail = () => { failure = true; child.kill("SIGKILL"); };
      const timer = setTimeout(fail, 10000); timer.unref();
      const discard = (chunk: Buffer) => { bytes += chunk.byteLength; if (bytes > 65536) fail(); };
      child.stdout!.on("data", discard); child.stderr!.on("data", discard); child.stdin!.on("error", fail);
      child.once("error", fail);
      child.once("close", code => { clearTimeout(timer); if (!failure && !closed && code === 0) accept(); else reject(new ProviderWorkflowError("unavailable")); });
      child.stdin!.end(JSON.stringify({ provider: input.providerId, key: input.apiKey }));
    });
  };
  return {
    async capabilities() { return { login: false, apiKey: await supported() }; },
    async apiKeyProviders() { return await supported() ? ["openai", "anthropic", "openrouter"] as const : []; },
    async verifyKey(input: ProviderWorkflowKey) {
      await createProviderKeyVerifier({ providerId: input.providerId, fetchFn: options.fetchFn, save: async () => save(input) })(input);
      if (closed) throw new ProviderWorkflowError("unavailable");
      committing = options.enableConnected(input.harnessInstanceId, input.providerId === "openai" ? "openai-api" : input.providerId, `hermes-key-${randomUUID()}`);
      try { await committing; } finally { committing = undefined; }
    },
    async close() {
      closed = true; active?.kill("SIGKILL");
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([Promise.all([drained, committing]), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new ProviderWorkflowError("unavailable")), 5000); })]); }
      finally { if (timer) clearTimeout(timer); }
      if (probing) await probing;
    },
  };
}
