import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod/v4";
import { boundedOperation } from "../bounded-operation.js";
import type { HermesGatewayEvent } from "./hermes-stdio-client.js";
import type { JevHermesCredentials } from "./jev-hermes-credentials.js";
const active = new Set<string | symbol>();
const MAX_PROFILES = 128;
const BROKER = "mcp__matrix_jev_recipe__jev_inbox_preview";
const Catalog = z.object({ lazy: z.boolean().optional(), tools: z.record(z.string().max(128), z.array(z.string().max(256)).max(64)) });

/** Exclusive per-run profile; no owner auth/config/hooks, ambient env, auxiliary inference or shell tools. */
export async function createJevHermesProfile(credentials: JevHermesCredentials, token: string) {
  if (active.size >= MAX_PROFILES || !/^[a-f0-9]{64}$/.test(token)) throw new Error("Restricted profile unavailable");
  // Reserve synchronously before the first await so simultaneous creates cannot exceed the cap.
  const reserved = Symbol("restricted-profile-reservation");
  active.add(reserved);
  let homePath: string | undefined;
  try {
    homePath = await mkdtemp(join(tmpdir(), "matrix-jev-recipe-"));
    active.delete(reserved); active.add(homePath);
    const hermesHome = join(homePath, "hermes");
    await mkdir(hermesHome, { mode: 0o700 });
    const config = { model: { default: credentials.model, provider: credentials.provider, base_url: credentials.baseUrl,
      api_mode: credentials.apiMode, context_length: 128000 }, agent: { max_turns: 12 },
      auxiliary: { background_review: { enabled: false }, title_generation: { enabled: false } },
      memory: { memory_enabled: false, user_profile_enabled: false }, tools: { tool_search: false },
      mcp_servers: { matrix_jev_recipe: { command: "/opt/matrix/bin/matrix-integrations-mcp",
        args: ["--require-scoped-capability", "--tool-surface=jev-inbox-preview"], enabled: true,
        tools: { resources: false, prompts: false } } } };
    await writeFile(join(hermesHome, "config.yaml"), JSON.stringify(config), { flag: "wx", mode: 0o600 });
    const ownedHome = homePath;
    return { homePath: ownedHome, env: { HOME: ownedHome, HERMES_HOME: hermesHome,
      PATH: "/opt/matrix/runtime/node/bin:/usr/bin:/bin", MATRIX_NODE_PREFIX: "/opt/matrix/runtime/node",
      MATRIX_AGENT_INTEGRATIONS_TOKEN: token, HERMES_TUI_TOOLSETS: "matrix_jev_recipe", HERMES_IGNORE_RULES: "1",
      HERMES_SINGLE_QUERY_SESSION: "1", HERMES_DISABLE_TELEMETRY: "1", HERMES_DISABLE_LAZY_INSTALLS: "1",
      ...credentials.env }, async close(): Promise<void> {
        try { await rm(ownedHome, { recursive: true, force: true }); }
        finally { active.delete(ownedHome); }
      } };
  } catch (error) {
    active.delete(reserved);
    if (homePath) {
      active.delete(homePath);
      try { await rm(homePath, { recursive: true, force: true }); }
      catch (cleanupError) { console.warn("[jev] Profile cleanup failed", { errorName: cleanupError instanceof Error ? cleanupError.name : "UnknownError" }); }
    }
    throw error;
  }
}

/** Native catalog, not prompt guidance or allowedTools, is the pre-inference admission proof. */
export function createJevHermesCatalogGate() {
  let sessionId: string | undefined;
  let observed: HermesGatewayEvent | undefined;
  let settled = false;
  let failure: Error | undefined;
  let notify: (() => void) | undefined;
  const inspect = () => {
    if (!observed || observed.session_id !== sessionId || settled) return;
    const parsed = Catalog.safeParse(observed.payload);
    if (parsed.success && parsed.data.lazy === true) return;
    const groups = parsed.success ? Object.values(parsed.data.tools) : [];
    const names = groups.flat();
    settled = true;
    if (!parsed.success || groups.length > 16 || names.length !== 1 || names[0] !== BROKER) {
      failure = new Error("Restricted native tool catalog unavailable");
    }
    notify?.();
  };
  return {
    observe(event: HermesGatewayEvent): void {
      if (event.type !== "session.info" || (sessionId && event.session_id !== sessionId)) return;
      observed = event; inspect();
    },
    setSession(id: string): void { sessionId = id; inspect(); },
    async ready(signal: AbortSignal): Promise<void> {
      await boundedOperation(async (deadline) => {
        if (!settled) await new Promise<void>((resolve, reject) => {
          const aborted = () => { notify = undefined; reject(new Error("Restricted catalog interrupted")); };
          deadline.addEventListener("abort", aborted, { once: true });
          notify = () => { deadline.removeEventListener("abort", aborted); resolve(); };
          if (deadline.aborted) aborted();
          else if (settled) notify();
        });
        deadline.throwIfAborted();
        if (failure) throw failure;
      }, 20_000, signal);
    },
  };
}
