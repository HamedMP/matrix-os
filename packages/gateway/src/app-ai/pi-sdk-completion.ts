import { mkdtemp, mkdir, rm, writeFile, lstat, open } from "node:fs/promises";
import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod/v4";
import { StringDecoder } from "node:string_decoder";
import { AppAiResultSchema, type AppAiResult } from "@matrix-os/contracts";
import { discoverPiAppSdk, type PiAppSdkDiscovery } from "./pi-sdk-discovery.js";
import { createGenericNativeWriter } from "../ai-providers/generic-native-writer.js";
import { spawnIsolatedProviderProcess } from "../coding-agents/provider-process-isolation.js";
import { PI_APP_SDK_WORKER } from "./pi-sdk-worker.js";
const MAX_BYTES = 256000;
function warnPiFailure(stage: string, error: unknown): void {
  const safeNames = ["Error", "TypeError", "SyntaxError", "RangeError", "AbortError", "TimeoutError", "ZodError"];
  const name = error instanceof Error && safeNames.includes(error.name) ? error.name : "UnknownError";
  console.warn(`[app-ai] Pi ${stage} failed`, name);
}
const RecordSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("supported"), models:z.array(z.string().min(1).max(512)).max(256) }), z.strictObject({ type: z.literal("authorize") }),
  z.strictObject({ type: z.literal("result"), text: AppAiResultSchema.shape.text }), z.strictObject({type:z.literal("drained"),token:z.string().uuid()}), z.strictObject({ type: z.literal("failed") }),
]);
export interface PiSdkAppTextInput {
  providerId: string; modelId: string; prompt: string; signal: AbortSignal;
  revalidate: () => Promise<boolean>;
}
async function safeModelConfiguration(home: string, scratch: string, provider: string): Promise<string | null> {
  const path = join(home, ".pi/agent/models.json");
  let file;
  try { file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) { if (error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  let raw: unknown;
  try {
    const metadata = await file.stat(); if (!metadata.isFile() || metadata.size > MAX_BYTES) throw Error("configuration");
    const buffer = Buffer.alloc(MAX_BYTES + 1); const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_BYTES) throw Error("configuration"); raw = JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"));
  } finally { await file.close(); }
  const config = z.object({ providers: z.record(z.string(), z.record(z.string(), z.unknown())).optional() }).parse(raw);
  const selected = config.providers?.[provider]; if (!selected) return null;
  // Request-auth and virtual routing overlays can change the chosen account or
  // model. Only credential-free physical model configuration is supported.
  const prohibited = new Set(["apiKey", "headers", "env", "oauth", "authHeader", "virtualModels", "fallback", "fallbacks"]);
  function inspect(value: unknown, depth = 0): void {
    if (depth > 16) throw Error("configuration");
    if (typeof value === "string" && (value.startsWith("!") || value.includes("$"))) throw Error("configuration");
    if (value && typeof value === "object") for (const [key, item] of Object.entries(value)) {
      if (prohibited.has(key)) throw Error("configuration"); inspect(item, depth + 1);
    }
  }
  inspect(selected);
  const target = join(scratch, "models.json");
  await writeFile(target, JSON.stringify({ providers: { [provider]: selected } }), { flag: "wx", mode: 0o600 });
  return target;
}
/** A reusable owner-scoped adapter. Call close() in gateway shutdown. Admission
 * shares the native settings writer fence; the public SDK owns refresh locking.
 * Availability probes never refresh credentials or execute a provider request. */
export function createPiSdkAppCompletion(options: {
  homePath: string;
  runtimePrefix?: string;
  discover?: () => Promise<PiAppSdkDiscovery>;
  writer?: Pick<ReturnType<typeof createGenericNativeWriter>, "acquire">;
}) {
  const writer = options.writer ?? createGenericNativeWriter(options.homePath);
  let active: { stop: () => Promise<void> } | undefined;
  let running: Promise<AppAiResult | string[]> | undefined;
  let closed = false;
  let admitted = false;
  async function run(mode: "probe" | "generate", input: PiSdkAppTextInput & {modelIds?:readonly string[]}): Promise<AppAiResult | string[]> {
    if (closed || admitted) throw Error("App AI is unavailable");
    const signal = AbortSignal.any([input.signal, AbortSignal.timeout(30000)]);
    signal.throwIfAborted(); admitted = true;
    let release: (() => Promise<void>) | undefined;
    let scratch: string | undefined;
    let drained = true;
    try {
      release = await writer.acquire("pi"); signal.throwIfAborted();
      if (!await input.revalidate()) throw Error("revoked");
      scratch = await mkdtemp(join(tmpdir(), "matrix-app-ai-pi-sdk-"));
      await mkdir(join(scratch, "agent"), { mode: 0o700 });
      const authPath = join(options.homePath, ".pi/agent/auth.json");
      for (const directory of [join(options.homePath, ".pi"), join(options.homePath, ".pi/agent")]) {
        const metadata = await lstat(directory); if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw Error("profile");
      }
      const modelId = input.modelId.startsWith(`${input.providerId}:`) ? input.modelId.slice(input.providerId.length + 1) : input.modelId;
      const modelsPath = await safeModelConfiguration(options.homePath, scratch, input.providerId);
      const discovery = await (options.discover ?? (() => discoverPiAppSdk({ homePath: scratch!, runtimePrefix: options.runtimePrefix, env: process.env as Record<string, string> })))();
      signal.throwIfAborted(); if (closed) throw Error("closed");
      const env: Record<string, string> = { HOME: scratch, MATRIX_HOME: scratch, PI_CODING_AGENT_DIR: join(scratch, "agent"), PI_OFFLINE: "1", PI_TELEMETRY: "0", TMPDIR: scratch, XDG_CONFIG_HOME: join(scratch, "config"), XDG_DATA_HOME: join(scratch, "data"), XDG_CACHE_HOME: join(scratch, "cache") };
      for (const key of ["PATH", "LANG", "LC_ALL"]) if (discovery.env[key]) env[key] = discovery.env[key]!;
      const child = spawnIsolatedProviderProcess(discovery.node, ["--input-type=module", "--eval", PI_APP_SDK_WORKER, discovery.entry, discovery.authStorageEntry ?? discovery.entry], { cwd: scratch, env, stdio: ["pipe", "pipe", "pipe"] });
      drained = false;
      let launchStarted = child.pid !== undefined;
      let launchFailed = false;
      child.once("spawn", () => { launchStarted = true; });
      const decoder = new StringDecoder("utf8");
      const drainToken=randomUUID();let drainProven=false;
      let exited = false; let bytes = 0; let buffer = ""; let result: AppAiResult | string[] | undefined; let failed = false;
      let resolveExit!: () => void;
      const exit = new Promise<void>(resolve => { resolveExit = resolve; });
      let rejectDone!: (error: Error) => void; let resolveDone!: () => void;
      const done = new Promise<void>((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
      void done.catch(error => warnPiFailure("worker completion", error));
      const fail = () => { failed = true; rejectDone(Error("App AI is unavailable")); };
      let stopping: Promise<void> | undefined;
      const stop = () => stopping ??= (async () => {
        if (exited) return;
        child.kill("SIGTERM");
        // SDK refresh deliberately ignores caller cancellation once a rotating
        // token exchange starts (15s cap). Give its persistence time to drain.
        let timer: ReturnType<typeof setTimeout> | undefined;
        try { await Promise.race([exit, new Promise<void>(resolve => { timer = setTimeout(resolve, 18000); })]); }
        finally { clearTimeout(timer); }
        if (!exited) {
          child.kill("SIGKILL");
          try { await Promise.race([exit, new Promise<void>(resolve => { timer = setTimeout(resolve, 2000); })]); }
          finally { clearTimeout(timer); }
          // Forced death cannot prove whether a rotated token was persisted.
          drained = false; throw Error("App AI is unavailable");
        }
      })();
      active = { stop };
      const abort = () => { fail(); void stop().catch(error => warnPiFailure("worker drain", error)); };
      signal.addEventListener("abort", abort, { once: true });
      const collect = (chunk: Buffer, stdout: boolean) => {
        if (chunk.byteLength) launchStarted = true;
        bytes += chunk.byteLength; if (bytes > MAX_BYTES) { fail(); void stop().catch(error => warnPiFailure("worker drain", error)); return; }
        if (!stdout) return;
        buffer += decoder.write(chunk);
        let newline = buffer.indexOf("\n");
        while (newline >= 0) {
          const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1); newline = buffer.indexOf("\n");
          try {
            const record = RecordSchema.parse(JSON.parse(line));
            if(record.type==="drained" && record.token===drainToken && !drainProven){drainProven=true;}
            else if (record.type === "failed") fail();
            else if (record.type === "supported" && mode === "probe" && !result) result = record.models;
            else if (record.type === "result" && mode === "generate" && !result) result = AppAiResultSchema.parse({text:record.text});
            else if (record.type === "authorize" && mode === "generate") {
              void input.revalidate().then(allowed => { if (!exited) child.stdin.end(JSON.stringify({ type: "authorized", allowed: allowed && !signal.aborted && !closed }) + "\n"); }, error => { warnPiFailure("authorization", error); if (!exited) child.stdin.end(JSON.stringify({ type: "authorized", allowed: false }) + "\n"); });
            } else fail();
          } catch (error) { warnPiFailure("worker output", error); fail(); void stop().catch(error => warnPiFailure("worker drain", error)); }
        }
      };
      child.stdout.on("data", chunk => collect(chunk, true)); child.stderr.on("data", chunk => collect(chunk, false));
      child.stdin.on("error", fail);
      child.once("error", error => {
        // Node reports failed OS launches with an error and no PID/spawn event.
        // A launched process still needs its explicit credential-drain receipt.
        launchFailed = !launchStarted && child.pid === undefined;
        warnPiFailure("worker launch", error); fail();
      });
      child.once("close", code => { buffer += decoder.end(); exited = true; drained = drainProven || launchFailed && !launchStarted && child.pid === undefined; resolveExit(); if (code === 0 && drainProven && result && !failed && !buffer.trim()) resolveDone(); else fail(); });
      child.stdin.write(JSON.stringify({ mode, drainToken, providerId: input.providerId, modelId, authPath, modelsPath, modelIds:input.modelIds?.map(id=>id.startsWith(`${input.providerId}:`)?id.slice(input.providerId.length+1):id), prompt: input.prompt }) + "\n");
      try {
        if (signal.aborted) abort();
        await done; signal.throwIfAborted();
        if (mode === "generate" && !await input.revalidate()) throw Error("revoked");
        signal.throwIfAborted(); return result!;
      } finally { signal.removeEventListener("abort", abort); await stop(); active = undefined; }
    } catch (error) { warnPiFailure("completion", error); throw Error("App AI is unavailable"); }
    finally {
      // Uncertain process death leaves the durable settings fence in place.
      try {
        if (drained && release) await release();
        if (drained && scratch) await rm(scratch, { recursive: true, force: true });
      } finally { admitted = false; }
    }
  }
  async function start(mode: "probe" | "generate", input: PiSdkAppTextInput & {modelIds?:readonly string[]}) {
    if (running || closed) throw Error("App AI is unavailable");
    const task = run(mode, input); running = task;
    try { return await task; } finally { if (running === task) running = undefined; }
  }
  return {
    async probe(input: Omit<PiSdkAppTextInput,"modelId"|"prompt"> & {modelIds:readonly string[]}):Promise<string[]> {
      if(input.modelIds.length>256)throw Error("App AI is unavailable");
      try { const result=await start("probe", {...input,modelId:input.modelIds[0]??"",prompt:""});return Array.isArray(result)?input.modelIds.filter(id=>result.includes(id.startsWith(`${input.providerId}:`)?id.slice(input.providerId.length+1):id)):[]; }
      catch(error){ warnPiFailure("readiness", error);return []; }
    },
    async supports(input: PiSdkAppTextInput): Promise<boolean> {
      try { const result=await start("probe", input);return Array.isArray(result)&&result.includes(input.modelId.startsWith(`${input.providerId}:`)?input.modelId.slice(input.providerId.length+1):input.modelId); }
      catch (error) { warnPiFailure("readiness", error); return false; }
    },
    async generate(input: PiSdkAppTextInput): Promise<AppAiResult> { const result = await start("generate", input); if (Array.isArray(result)) throw Error("App AI is unavailable"); return result; },
    async close(): Promise<void> { closed = true; await active?.stop();
      if (running) await running.catch(error => warnPiFailure("task shutdown", error)); },
  };
}
