import { randomBytes, randomUUID, createHash } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import type { ProviderSettingsStoreWriter } from "./provider-settings-store.js";
import { z } from "zod/v4";
import type { OpenCodeProcess, OpenCodeSpawnFn } from "../coding-agents/opencode-provider.js";
import { spawnIsolatedProviderProcess } from "../coding-agents/provider-process-isolation.js";
import { ProviderWorkflowError, type ProviderWorkflowAdapter } from "./provider-workflows.js";
import { createProviderKeyVerifier } from "./provider-workflow-key.js";

const methodsSchema = z.record(z.string().max(100), z.array(z.object({
  type: z.enum(["oauth", "api"]), label: z.string().max(200), prompts: z.array(z.unknown()).max(20).optional(),
})).max(32));
const authorizationSchema = z.object({ url: z.string().max(2048), method: z.literal("auto"), instructions: z.string().max(1000) });
const RESPONSE_LIMIT = 256 * 1024;
export interface OpenCodeAuthSession {
  request(path: string, method?: "GET" | "POST" | "PUT", body?: unknown, timeout?: number): Promise<unknown>;
  close(): Promise<void>;
}
/** Private server only: no credentials or raw native output are returned to callers.
 * Protocol evidence: OpenCode v1.18.34 e9f8a210b9e2b1e13d375b84906069886eb3b767,
 * provider.auth/authorize/callback and openai/codex.ts headless method.
 * The exact running executable must advertise the method before capability exposure. */
export async function openOpenCodeAuthSession(options: {
  command: string; cwd: string; env: Record<string, string>; spawn?: OpenCodeSpawnFn; fetch?: typeof fetch;
}): Promise<OpenCodeAuthSession> {
  if (!isAbsolute(options.command) || !isAbsolute(options.cwd) || (options.env.HOME && resolve(options.env.HOME) !== resolve(options.cwd))) throw new ProviderWorkflowError("unavailable");
  // Never inherit operator provider keys, config redirects, or credentials.
  const environment: Record<string, string> = { HOME: options.cwd, MATRIX_HOME: options.cwd };
  for (const key of ["PATH", "MATRIX_NODE_PREFIX", "LANG", "LC_ALL"]) if (options.env[key]) environment[key] = options.env[key]!;
  const password = randomBytes(32).toString("hex");
  const controller = new AbortController();
  const headers = { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`,
    "x-opencode-directory": encodeURIComponent(options.cwd), "content-type": "application/json" };
  const launch = options.spawn ?? ((command, args, opts) => spawnIsolatedProviderProcess(command, args, { ...opts, stdio: ["ignore", "pipe", "pipe"] }));
  let child: OpenCodeProcess | undefined;
  let exited = false;
  let resolveExit!: () => void;
  const exit = new Promise<void>(resolve => { resolveExit = resolve; });
  let closePromise: Promise<void> | undefined;
  const close = () => closePromise ??= (async () => {
    controller.abort();
    if (!child || exited) return;
    child.kill("SIGTERM");
    const wait = async (ms: number) => {
      let timer!: ReturnType<typeof setTimeout>;
      try { await Promise.race([exit, new Promise<void>(resolve => { timer = setTimeout(resolve, ms); })]); }
      finally { clearTimeout(timer); }
    };
    await wait(2000);
    if (!exited) { child.kill("SIGKILL"); await wait(2000); }
    if (!exited) throw new ProviderWorkflowError("unavailable");
  })();
  let origin: string;
  try {
    origin = await new Promise<string>((resolve, reject) => {
      let output = ""; let bytes = 0; let ready = false;
      const timer = setTimeout(() => reject(new ProviderWorkflowError("unavailable")), 10000);
      const stopTimer = () => clearTimeout(timer);
      try {
        child = launch(options.command, ["serve", "--hostname", "127.0.0.1", "--port", "0"], { cwd: options.cwd,
          env: { ...environment, OPENCODE_SERVER_USERNAME: "opencode", OPENCODE_SERVER_PASSWORD: password, OPENCODE_PURE: "1" } });
      } catch (error) { stopTimer(); reject(error); return; }
      const outputLimit = (chunk: Buffer) => {
        bytes += chunk.byteLength;
        if (bytes > 65536) { stopTimer(); controller.abort(); reject(new ProviderWorkflowError("unavailable")); }
      };
      child.stderr.on("data", outputLimit);
      child.stdout.on("data", chunk => {
        outputLimit(chunk);
        if (ready || controller.signal.aborted) return;
        output += chunk.toString("utf8");
        if (Buffer.byteLength(output) > 16384) { stopTimer(); reject(new ProviderWorkflowError("unavailable")); return; }
        const match = /(?:^|\n)opencode server listening on http:\/\/127\.0\.0\.1:(\d+)\r?(?:\n|$)/.exec(output);
        if (!match) return;
        const port = Number(match[1]);
        if (port < 1 || port > 65535) { stopTimer(); reject(new ProviderWorkflowError("unavailable")); return; }
        ready = true; output = ""; stopTimer(); resolve(`http://127.0.0.1:${port}`);
      });
      child.once("error", () => { stopTimer(); controller.abort(); reject(new ProviderWorkflowError("unavailable")); });
      child.once("exit", () => { exited = true; resolveExit(); stopTimer(); controller.abort(); reject(new ProviderWorkflowError("unavailable")); });
    });
  } catch (error) {
    await close();
    console.warn("[provider-workflow] OpenCode auth startup unavailable:", error instanceof Error ? error.name : "UnknownError");
    throw new ProviderWorkflowError("unavailable");
  }
  return {
    close,
    async request(path, method = "GET", body, timeout = 10000) {
      if (!/^\/(?:provider(?:\/auth|\/openai\/oauth\/(?:authorize|callback))?|auth\/openai|global\/health)$/.test(path)) throw new ProviderWorkflowError("unavailable");
      const response = await (options.fetch ?? fetch)(`${origin}${path}`, { method, headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: "error",
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(timeout)]) });
      if (!response.ok || !response.body) { await response.body?.cancel(); throw new ProviderWorkflowError("unavailable"); }
      const reader = response.body.getReader(); let size = 0; const chunks: Uint8Array[] = [];
      try {
        while (true) { const next = await reader.read(); if (next.done) break;
          size += next.value.byteLength; if (size > RESPONSE_LIMIT) throw new ProviderWorkflowError("unavailable"); chunks.push(next.value); }
        return JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } finally { await reader.cancel(); reader.releaseLock(); }
    },
  };
}

export function createOpenCodeSettingsConnection(options: {
  session: () => Promise<OpenCodeAuthSession>;
  enableConnected: (harnessInstanceId: string, idempotencyKey: string) => Promise<void>;
  fetch?: typeof fetch;
}) {
  let activeSessions = 0; let shutdown = false;
  const sessions = new Set<OpenCodeAuthSession>(); // Maximum two; remove on confirmed cleanup.
  const openSession = async () => {
    if (shutdown || activeSessions >= 2) throw new ProviderWorkflowError("unavailable");
    activeSessions += 1;
    let session: OpenCodeAuthSession;
    try { session = await options.session(); } catch (error) { activeSessions -= 1; throw error; }
    if (shutdown) { await session.close(); activeSessions -= 1; throw new ProviderWorkflowError("unavailable"); }
    let closed = false; let closing: Promise<void> | undefined;
    const tracked: OpenCodeAuthSession = { request: session.request.bind(session), async close() {
      if (closed) return;
      closing ??= session.close().then(() => { closed = true; activeSessions -= 1; sessions.delete(tracked); });
      await closing;
    } };
    sessions.add(tracked); return tracked;
  };
  let capabilityProbe: Promise<{ login: boolean; apiKey: boolean }> | undefined;
  let cachedCapability: { value: { login: boolean; apiKey: boolean }; expiresAt: number } | undefined;
  async function discover(session: OpenCodeAuthSession) {
    const health = z.object({ healthy: z.literal(true), version: z.string().min(1).max(100) }).parse(await session.request("/global/health"));
    if (!/^1\./.test(health.version)) throw new ProviderWorkflowError("unavailable");
    const methods = methodsSchema.parse(await session.request("/provider/auth"));
    // Browser localhost callbacks are unusable for a remote Matrix computer.
    // Only the official headless auto-polling method is advertised.
    const index = methods.openai?.findIndex(method => method.type === "oauth" && method.label === "ChatGPT Pro/Plus (headless)" && !method.prompts?.length) ?? -1;
    return { index, key: methods.openai?.some(method => method.type === "api" && !method.prompts?.length) ?? false };
  }
  return {
    async close() {
      shutdown = true;
      const outcomes = await Promise.allSettled([...sessions].map(session => session.close()));
      if (outcomes.some(result => result.status === "rejected")) throw new ProviderWorkflowError("unavailable");
      if (capabilityProbe) await capabilityProbe.catch(error => console.warn("[provider-workflow] OpenCode probe closed:", error instanceof Error ? error.name : "UnknownError"));
    },
    async capabilities() {
      if (shutdown) throw new ProviderWorkflowError("unavailable");
      if (cachedCapability && Date.now() < cachedCapability.expiresAt) return cachedCapability.value;
      if (capabilityProbe) return capabilityProbe;
      capabilityProbe = (async () => {
        const session = await openSession();
        try { const discovered = await discover(session);
          const value = { login: discovered.index >= 0, apiKey: discovered.key };
          cachedCapability = { value, expiresAt: Date.now() + 15000 }; return value;
        } finally { await session.close(); }
      })();
      try { return await capabilityProbe; } finally { capabilityProbe = undefined; }
    },
    async start(input: Parameters<ProviderWorkflowAdapter["start"]>[0]) {
      if (input.request.kind !== "login" || input.request.method !== "device_code") throw new ProviderWorkflowError("unavailable");
      const session = await openSession(); let stopped = false; let timer: ReturnType<typeof setTimeout> | undefined;
      const cancel = async () => { stopped = true; if (timer) clearTimeout(timer); await session.close(); };
      try {
        const { index } = await discover(session);
        if (index < 0) throw new ProviderWorkflowError("unavailable");
        const auth = authorizationSchema.parse(await session.request("/provider/openai/oauth/authorize", "POST", { method: index }));
        const url = new URL(auth.url);
        const code = /^Enter code: ([A-Z0-9]{4,8}(?:-[A-Z0-9]{4,8})?)$/.exec(auth.instructions)?.[1];
        if (url.origin !== "https://auth.openai.com" || url.pathname !== "/codex/device" || url.search || url.hash || url.username || url.password || !code) throw new ProviderWorkflowError("unavailable");
        input.publish({ authorizationUrl: url.toString(), deviceCode: code });
        timer = setTimeout(() => { void cancel().then(() => input.publish({ state: "expired", safeFailure: "expired" })).catch(error => {
          console.warn("[provider-workflow] OpenCode expiry cleanup unavailable:", error instanceof Error ? error.name : "UnknownError");
          input.publish({ safeFailure: "unavailable" });
        }); }, 600000); timer.unref?.();
        void (async () => {
          try {
            const accepted = await session.request("/provider/openai/oauth/callback", "POST", { method: index }, 600000);
            if (stopped) return;
            if (accepted !== true) throw new ProviderWorkflowError("rejected");
            // The native callback saves the profile before returning true. The
            // canonical route writer rechecks the exact native source/model;
            // avoid buffering /provider's unrelated, potentially huge catalog.
            await options.enableConnected(input.request.harnessInstanceId, `opencode-connect-${createHash("sha256").update(input.request.idempotencyKey).digest("hex")}`);
            await session.close();
            if (!stopped) input.publish({ state: "succeeded", safeFailure: null });
          } catch (error) {
            if (!stopped) { console.warn("[provider-workflow] OpenCode connection unavailable:", error instanceof Error ? error.name : "UnknownError"); input.publish({ state: "failed", safeFailure: error instanceof ProviderWorkflowError && error.code === "rejected" ? "rejected" : "unavailable" }); }
          } finally { await cancel(); }
        })().catch(error => console.warn("[provider-workflow] OpenCode cleanup unavailable:", error instanceof Error ? error.name : "UnknownError"));
        return { cancel };
      } catch (error) { await cancel(); throw error; }
    },
    async verifyKey(input: Parameters<NonNullable<ProviderWorkflowAdapter["verifyKey"]>>[0]) {
      if (input.providerId !== "openai") throw new ProviderWorkflowError("rejected");
      const session = await openSession();
      try {
        if (!(await discover(session)).key) throw new ProviderWorkflowError("unavailable");
        await createProviderKeyVerifier({ providerId: "openai", fetchFn: options.fetch,
          save: async key => { if (await session.request("/auth/openai", "PUT", { type: "api", key }) !== true) throw new ProviderWorkflowError("unavailable"); },
        })(input);
        await options.enableConnected(input.harnessInstanceId, `opencode-key-${randomUUID()}`);
      } finally { await session.close(); }
    },
  };
}

/** An explicit OpenAI Connect binds the CLI-owned source and enables in one
 * revision-checked mutation. Catalog observation alone never restores old Off. */
export async function enableOpenCodeConnectedRoute(store: ProviderSettingsStoreWriter, harnessInstanceId: string, idempotencyKey: string) {
  return enableNativeSettingsConnectedRoute(store, harnessInstanceId, "opencode", "openai", idempotencyKey);
}
export async function enableNativeSettingsConnectedRoute(store: ProviderSettingsStoreWriter, harnessInstanceId: string, kind: "opencode" | "pi" | "openclaw", provider: "openai" | "openai-codex", idempotencyKey: string) {
  const snapshot = await store.getSnapshot({ refresh: true });
  const harness = snapshot.harnesses.find(row => row.id === harnessInstanceId && row.harness === kind);
  const source = snapshot.accessSources.find(row => row.kind === "harness_profile" && row.harness === kind && row.providerId === provider && row.localObservation?.state === "present_unverified");
  const models = snapshot.modelProviders.find(row => row.id === provider)?.models.filter(model => model.enabled && source?.eligibleModelIds.includes(model.id)) ?? [];
  const model = models.find(row => row.id === harness?.route.modelId) ?? models[0];
  if (!harness || !source || !model || snapshot.access.mode !== "writable" || snapshot.atomicConnectSupported !== true) throw new ProviderWorkflowError("unavailable");
  await store.mutate({ type: "set_route", harnessInstanceId, route: { kind: "configurable", providerId: provider, modelId: model.id }, accessSourceId: source.id, accountId: source.accountId, enableHarness: true, expectedRevision: snapshot.revision, idempotencyKey });
}
