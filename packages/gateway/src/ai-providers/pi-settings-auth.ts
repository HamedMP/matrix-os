import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { lstat, realpath, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID, createHash } from "node:crypto";
import { z } from "zod/v4";
import type { OpenCodeProcess, OpenCodeSpawnFn } from "../coding-agents/opencode-provider.js";
import { spawnIsolatedProviderProcess } from "../coding-agents/provider-process-isolation.js";
import { ProviderWorkflowError, type ProviderWorkflowAdapter } from "./provider-workflows.js";
import { createProviderKeyVerifier } from "./provider-workflow-key.js";

/** Public API verified against @earendil-works/pi-coding-agent 0.99.2
 * (005af57d88ee23b33778f343a9595b32e67ff788) and 1.0.0
 * (a13d35a742c6ef8462812a28fbe1d8c8b7431c32). Discard credential return values. */
export const PI_SETTINGS_AUTH_WORKER = `
const [entry,mode] = process.argv.slice(1);
const send = record => process.stdout.write(JSON.stringify(record)+"\\n");
const stop = new AbortController();
process.on("SIGTERM",()=>stop.abort());
try {
  const sdk = await import(entry);
  if (typeof sdk.ModelRuntime?.create!=="function" || typeof sdk.ModelRuntime.prototype.login!=="function") throw new Error("unsupported");
  if(mode==="probe") { send({type:"capability",supported:true}); }
  else {
    let key="";
    if(mode==="key") { let input=""; for await(const chunk of process.stdin) {input+=chunk.toString("utf8");if(Buffer.byteLength(input)>8192)throw new Error("input");} key=JSON.parse(input).key;if(typeof key!=="string"||key.length>4096)throw new Error("input");input=""; }
    const runtime=await sdk.ModelRuntime.create({refreshOnCreate:false,allowModelNetwork:false,modelsPath:null,signal:stop.signal});
    await runtime.login(mode==="key"?"openai":"openai-codex",mode==="key"?"api_key":"oauth",{
      signal:stop.signal,
      prompt: async prompt => {
        if(mode==="key"&&prompt.type==="secret")return key;
        if(mode==="oauth"&&prompt.type==="select"&&prompt.options?.some(option=>option.id==="device_code"))return "device_code";
        throw new Error("unsupported prompt");
      },
      notify: event => { if(event.type==="device_code")send({type:"device_code",code:event.userCode,url:event.verificationUri}); }
    });
    key="";send({type:"completed"});
  }
  process.stdout.write("",()=>process.exit(0));
} catch (error) {
  // Native errors can contain credential material. Log only fixed categories.
  const category = stop.signal.aborted || error instanceof Error && error.name === "AbortError"
    ? "cancelled" : error instanceof SyntaxError ? "invalid_input"
    : error instanceof Error ? "sdk_failure" : "unexpected_failure";
  console.error("[provider-workflow] Pi native authentication failed:", category);
  send({type:"failed"});process.stdout.write("",()=>process.exit(1));
}
`;
const recordSchema = z.discriminatedUnion("type", [z.object({ type: z.literal("capability"), supported: z.literal(true) }).strict(),
  z.object({ type: z.literal("device_code"), code: z.string().regex(/^[A-Z0-9]{4,8}(?:-[A-Z0-9]{4,8})?$/), url: z.literal("https://auth.openai.com/codex/device") }).strict(),
  z.object({ type: z.literal("completed") }).strict(), z.object({ type: z.literal("failed") }).strict()]);
export type PiAuthDiscovery = { node: string; entry: string; env: Record<string, string>; cwd: string };
/** Public package metadata and --version only; never inspect owner auth files. */
export async function discoverPiSettingsAuth(options: { homePath: string; runtimePrefix?: string; env: Record<string, string> }): Promise<PiAuthDiscovery> {
  const prefix = resolve(options.runtimePrefix ?? "/opt/matrix/runtime/node");
  const root = join(prefix, "lib/node_modules/@earendil-works/pi-coding-agent");
  const cli = join(prefix, "bin/pi"); const metadata = join(root, "package.json");
  const info = await lstat(metadata); if (!info.isFile() || info.isSymbolicLink() || info.size > 16384) throw new ProviderWorkflowError("unavailable");
  const pkg = z.object({ name: z.literal("@earendil-works/pi-coding-agent"), version: z.enum(["0.99.2", "1.0.0"]) }).parse(JSON.parse(await readFile(metadata, "utf8")));
  if (await realpath(cli) !== await realpath(join(root, "dist/bundle/cli.js"))) throw new ProviderWorkflowError("unavailable");
  const env: Record<string, string> = { HOME: resolve(options.homePath), MATRIX_HOME: resolve(options.homePath) };
  for (const key of ["PATH", "MATRIX_NODE_PREFIX", "LANG", "LC_ALL"]) if (options.env[key]) env[key] = options.env[key]!;
  const version = await promisify(execFile)(cli, ["--version"], { cwd: env.HOME, env, timeout: 5000, maxBuffer: 4096, encoding: "utf8", windowsHide: true });
  if (version.stdout.trim() !== pkg.version) throw new ProviderWorkflowError("unavailable");
  const entry = await realpath(join(root, "dist/index.js"));
  if (!entry.startsWith(`${await realpath(root)}/`)) throw new ProviderWorkflowError("unavailable");
  return { node: join(prefix, "bin/node"), entry: pathToFileURL(entry).href, env, cwd: env.HOME };
}
export function createPiSettingsConnection(options: {
  discover: () => Promise<PiAuthDiscovery>;
  enableConnected: (id: string, provider: "openai" | "openai-codex", key: string) => Promise<void>;
  spawn?: OpenCodeSpawnFn; fetch?: typeof fetch;
}) {
  const children = new Map<OpenCodeProcess, () => Promise<void>>(); // At most two; remove only after confirmed exit.
  let shutdown = false;
  let cached: { expiresAt: number; supported: boolean } | undefined;
  let probing: Promise<{ login: boolean; apiKey: boolean }> | undefined;
  async function run(mode: "probe" | "oauth" | "key", publish: (record: z.infer<typeof recordSchema>) => void, key?: string) {
    if (shutdown || children.size >= 2) throw new ProviderWorkflowError("unavailable");
    const config = await options.discover();
    if (shutdown || children.size >= 2) throw new ProviderWorkflowError("unavailable");
    const launch = options.spawn ?? ((command, args, opts) => spawnIsolatedProviderProcess(command, args, { ...opts, stdio: ["pipe", "pipe", "pipe"] }));
    const child: OpenCodeProcess = launch(config.node, ["--input-type=module", "--eval", PI_SETTINGS_AUTH_WORKER, config.entry, mode], { cwd: config.cwd, env: config.env });
    let bytes = 0; let buffer = ""; let exited = false; let completed = false; let expired = false;
    let resolveDone!: () => void; let rejectDone!: (error: unknown) => void;
    const done = new Promise<void>((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
    // A child can fail before its caller attaches a completion listener (for
    // example, a missing stdin). Observe that rejection without replacing the
    // original rejected promise; callers still receive and handle the failure.
    void done.catch(error => console.warn("[provider-workflow] Pi native task failed:",
      error instanceof ProviderWorkflowError ? "workflow_failure" : "unexpected_failure"));
    let resolveExit!: () => void;
    const exit = new Promise<void>(resolve => { resolveExit = resolve; });
    let closePromise: Promise<void> | undefined;
    const close = () => closePromise ??= (async () => {
      if (exited) return;
      child.kill("SIGTERM");
      let timer!: ReturnType<typeof setTimeout>;
      try { await Promise.race([exit, new Promise<void>(resolve => { timer = setTimeout(resolve, 2000); })]); }
      finally { clearTimeout(timer); }
      if (!exited) child.kill("SIGKILL");
      try { await Promise.race([exit, new Promise<void>(resolve => { timer = setTimeout(resolve, 2000); })]); }
      finally { clearTimeout(timer); }
      if (!exited) throw new ProviderWorkflowError("unavailable");
    })();
    children.set(child, close);
    const timer = setTimeout(() => { expired = true; void close().catch(error => console.warn("[provider-workflow] Pi cleanup unavailable:", error instanceof Error ? error.name : "UnknownError")); }, mode === "oauth" ? 600000 : 10000); timer.unref?.();
    const fail = () => { rejectDone(new ProviderWorkflowError("unavailable")); void close().catch(error => console.warn("[provider-workflow] Pi cleanup unavailable:", error instanceof Error ? error.name : "UnknownError")); };
    child.stderr.on("data", chunk => { bytes += chunk.byteLength; if (bytes > 65536) fail(); });
    child.stdout.on("data", chunk => {
      bytes += chunk.byteLength; if (bytes > 65536) { fail(); return; }
      buffer += chunk.toString("utf8"); if (Buffer.byteLength(buffer) > 16384) { fail(); return; }
      let line = buffer.indexOf("\n");
      while (line >= 0) {
        const text = buffer.slice(0, line); buffer = buffer.slice(line + 1); line = buffer.indexOf("\n");
        try { const record = recordSchema.safeParse(JSON.parse(text)); if (!record.success) continue;
          if (record.data.type === "completed" || record.data.type === "capability") completed = true;
          if (record.data.type === "failed") fail(); else publish(record.data);
        } catch (error) { if (!(error instanceof SyntaxError)) fail(); }
      }
    });
    child.once("error", fail as (error: Error) => void);
    child.once("exit", ((code: number | null) => { exited = true; resolveExit(); children.delete(child); clearTimeout(timer); buffer = ""; code === 0 && completed ? resolveDone() : rejectDone(new ProviderWorkflowError("unavailable")); }) as (code: number | null) => void);
    if (mode === "key") {
      const stdin = (child as OpenCodeProcess & { stdin?: { end(value: string): void; on(event: "error", callback: () => void): void } }).stdin;
      if (!stdin) { fail(); await close(); throw new ProviderWorkflowError("unavailable"); }
      stdin.on("error", fail); stdin.end(JSON.stringify({ key }));
    }
    return { done, close, get expired() { return expired; } };
  }
  return {
    async close() { shutdown = true; const results = await Promise.allSettled([...children.values()].map(close => close())); if (results.some(result => result.status === "rejected")) throw new ProviderWorkflowError("unavailable"); if (probing) await probing.catch(error => console.warn("[provider-workflow] Pi probe closed:", error instanceof Error ? error.name : "UnknownError")); },
    async capabilities() {
      if (shutdown) throw new ProviderWorkflowError("unavailable");
      if (cached && Date.now() < cached.expiresAt) return { login: cached.supported, apiKey: cached.supported };
      if (probing) return probing;
      probing = (async () => { let supported = false; const task = await run("probe", record => { supported = record.type === "capability"; });
        try { await task.done; cached = { supported, expiresAt: Date.now() + 15000 }; return { login: supported, apiKey: supported }; } finally { await task.close(); } })();
      try { return await probing; } finally { probing = undefined; }
    },
    async start({ request, publish }: Parameters<ProviderWorkflowAdapter["start"]>[0]) {
      if (request.kind !== "login" || request.method !== "device_code") throw new ProviderWorkflowError("unavailable");
      let cancelled = false;
      const task = await run("oauth", record => { if (!cancelled && record.type === "device_code") publish({ deviceCode: record.code, authorizationUrl: record.url }); });
      void task.done.then(async () => { if (!cancelled && !shutdown) await options.enableConnected(request.harnessInstanceId, "openai-codex", `pi-connect-${createHash("sha256").update(request.idempotencyKey).digest("hex")}`);
        if (!cancelled && !shutdown) publish({ state: "succeeded", safeFailure: null });
      }).catch(error => { if (!cancelled && !shutdown) { console.warn("[provider-workflow] Pi connection unavailable:", error instanceof Error ? error.name : "UnknownError"); publish({ state: task.expired ? "expired" : "failed", safeFailure: task.expired ? "expired" : "unavailable" }); } });
      return { async cancel() { cancelled = true; await task.close(); } };
    },
    async verifyKey(input: Parameters<NonNullable<ProviderWorkflowAdapter["verifyKey"]>>[0]) {
      if (input.providerId !== "openai") throw new ProviderWorkflowError("rejected");
      await createProviderKeyVerifier({ providerId: "openai", fetchFn: options.fetch, save: async key => {
        const task = await run("key", () => {}, key); try { await task.done; } finally { await task.close(); }
      } })(input);
      await options.enableConnected(input.harnessInstanceId, "openai", `pi-key-${randomUUID()}`);
    },
  };
}
