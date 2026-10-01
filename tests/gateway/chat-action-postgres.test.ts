import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { fork, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile, mkdir, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatRepository } from "../../packages/gateway/src/chat/repository.js";
import { ActionRepository } from "../../packages/gateway/src/chat/action-repository.js";
import { createCanonicalActionAuthority } from "../../packages/gateway/src/chat/action-authority.js";
import { createCanonicalActionTools } from "../../packages/gateway/src/chat/action-tools.js";
import { normalizedArgumentDigest } from "../../packages/gateway/src/chat/argument-digest.js";
import type { ChatDatabase } from "../../packages/gateway/src/chat/database.js";
// This suite NEVER reads DATABASE_URL. The URL must explicitly identify a disposable test DB.
const url = process.env.MATRIX_TEST_POSTGRES_URL;
const schema = `chat_actions_test_${randomUUID().replaceAll("-", "")}`;
const owner = { type: "personal" as const, ownerId: "owner_pg_actions" };
const policy = { revision: "actions_pg_v1", actionMode: "canonical_actions" as const, workspaceScope: "apps", tools: ["matrix_apply_app_files"], delegation: false };
let admin: Kysely<ChatDatabase>; let chat: ChatRepository; let actions: ActionRepository;
let home: string | undefined;
describe.skipIf(!url)("disposable Postgres canonical action claims (explicit authorization gate)", () => {
  beforeAll(async () => {
    const parsed = new URL(url!);
    if (!/test|disposable/i.test(parsed.pathname)) throw new Error("MATRIX_TEST_POSTGRES_URL must name an isolated test database");
    admin = new Kysely({ dialect: new PostgresDialect({ pool: new Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 5_000 }) }) });
    await sql`create schema ${sql.id(schema)}`.execute(admin);
    chat = new ChatRepository(new PostgresDialect({ pool: new Pool({ connectionString: url, max: 4, connectionTimeoutMillis: 5_000, options: `-c search_path=${schema} -c statement_timeout=10000` }) }));
    await chat.bootstrap(); actions = new ActionRepository(chat.kysely);
    await chat.create(owner, { id: "chat_pg_actions", clientRequestId: "req_create_pg_actions", title: "Disposable action gate" });
    await chat.kysely.insertInto("chat_messages").values({ id: "msg_pg_actions", chat_id: "chat_pg_actions", seq: 1, role: "user", purpose: "ai_request", state: "committed", turn_id: null, run_id: null, actor_id: owner.ownerId, parts: JSON.stringify([{ type: "text", text: "apply" }]), byte_count: 5, search_text: "apply", created_at: new Date() }).execute();
    await chat.kysely.insertInto("chat_turns").values({ id: "cturn_pg_actions", chat_id: "chat_pg_actions", client_request_id: "req_turn_pg_actions", base_message_seq: 0, input_message_id: "msg_pg_actions", status: "running", created_at: new Date(), updated_at: new Date() }).execute();
    await chat.kysely.insertInto("chat_runs").values({ id: "run_pg_actions", chat_id: "chat_pg_actions", turn_id: "cturn_pg_actions", client_request_id: "req_run_pg_actions", attempt: 1, driver_kind: "codex", instance_id: "codex_default", selection: JSON.stringify({ instanceId: "codex_default", model: "fake_model" }), interaction_mode: "default", permission_mode: "supervised", execution_root: null, execution_root_fingerprint: null, status: "running", outcome: null, history_boundary_seq: 0, capability_snapshot: JSON.stringify({}), run_policy: JSON.stringify({ memoryMode: "ordinary", source: "typed", nativeCheckpointPolicy: "reusable", executionPolicy: policy }), created_at: new Date(), updated_at: new Date() }).execute();
  });
  afterAll(async () => { if (chat) await chat.kysely.destroy(); if (admin) { await sql`drop schema if exists ${sql.id(schema)} cascade`.execute(admin); await admin.destroy(); } if (home) await rm(home, { recursive: true, force: true }); });
  it("one concurrent authorization consumer wins; reconstructed running identity cannot be claimed", async () => {
    const now = new Date().toISOString();
    const op = await actions.propose({ id: "action_pg_claim", owner, chatId: "chat_pg_actions", runId: "run_pg_actions", toolId: policy.tools[0]!, workspaceScope: "apps", schemaRevision: "files_v1", executionPolicy: policy, policyRevision: policy.revision, arguments: { app: "notes" }, argumentDigest: normalizedArgumentDigest({ app: "notes" }), state: "waiting_for_approval", revision: 0, cancellationRequested: false, createdAt: now, updatedAt: now });
    const ready = await actions.decide({ owner, chatId: op.chatId, runId: op.runId, actionId: op.id, argumentDigest: op.argumentDigest, decision: "approve", clientRequestId: "req_pg_approve" });
    const claims = await Promise.all(Array.from({ length: 4 }, () => actions.claim(ready)));
    expect(claims.filter(Boolean)).toHaveLength(1);
    const recovered = new ActionRepository(chat.kysely);
    const persisted = await recovered.get({ owner, chatId: op.chatId, runId: op.runId, actionId: op.id });
    expect(persisted.state).toBe("running"); expect(await recovered.claim(persisted)).toBeNull();
  });
  it("reconciles a SIGKILL after a real bounded file effect without redispatch", async () => {
    home = await mkdtemp(join(tmpdir(), "matrix-action-crash-"));
    const appRoot = join(home, "apps", "notes");
    await mkdir(join(appRoot, "src"), { recursive: true });
    await writeFile(join(appRoot, "matrix.json"), JSON.stringify({ slug: "notes", name: "Notes", version: "1.0.0", runtime: "vite", runtimeVersion: "^24.0.0", scope: "personal", permissions: [], build: { install: "pnpm install --frozen-lockfile", command: "vite build", output: "dist" } }));
    await writeFile(join(appRoot, "package.json"), JSON.stringify({ scripts: { build: "vite build" }, dependencies: { react: "19.0.0", "react-dom": "19.0.0" }, devDependencies: { vite: "7.0.0" } }));
    await writeFile(join(appRoot, "index.html"), "<div id=\"root\"></div>");
    await writeFile(join(appRoot, "src", "main.tsx"), "export default 'notes';\n");
    const effectPath = join(appRoot, "src", "crash-proof.ts");
    const effectContent = "export const crashProof = true;\n";
    const args = { app: "notes", files: [{ path: "src/crash-proof.ts", content: effectContent, expectedSha256: null }] };
    const actionId = "action_pg_process_crash";
    const config = Buffer.from(JSON.stringify({ url, schema, home, ownerId: owner.ownerId, chatId: "chat_pg_actions", runId: "run_pg_actions", actionId, arguments: args })).toString("base64url");
    let child: ChildProcess | undefined;
    try {
      child = fork(new URL("../fixtures/aoede/action-crash-worker.ts", import.meta.url), [], {
        execArgv: ["--import=tsx"], stdio: ["ignore", "pipe", "pipe", "ipc"],
        env: { PATH: process.env.PATH, NODE_PATH: process.env.NODE_PATH, MATRIX_ACTION_CRASH_CONFIG: config },
      });
      let stderr = "";
      child.stderr?.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-4_096); });
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("child did not reach the effect boundary")), 15_000);
        child!.once("error", (error) => { clearTimeout(timer); reject(error); });
        child!.once("exit", (code, signal) => { clearTimeout(timer); reject(new Error(`child exited before effect: ${code ?? signal}: ${stderr}`)); });
        child!.on("message", (message) => { if ((message as { type?: string }).type === "effect_committed") { clearTimeout(timer); resolve(); } });
      });
      expect(await readFile(effectPath, "utf8")).toBe(effectContent);
      expect((await actions.get({ owner, chatId: "chat_pg_actions", runId: "run_pg_actions", actionId })).state).toBe("running");
      child.kill("SIGKILL");
      await new Promise<void>((resolve, reject) => { const timer = setTimeout(() => reject(new Error("child did not terminate")), 5_000); child!.once("exit", () => { clearTimeout(timer); resolve(); }); });
      child = undefined;

      const recoveredRepository = new ActionRepository(chat.kysely);
      const realTools = createCanonicalActionTools({ homeForOwner: async () => home! });
      let redispatches = 0;
      const recoveredAuthority = createCanonicalActionAuthority({ repository: recoveredRepository, tools: realTools.map((tool) => tool.toolId === policy.tools[0] ? {
        ...tool,
        execute: async (input) => { redispatches++; return tool.execute(input); },
      } : tool), qualifyPolicy: async () => policy, onEvent: async () => undefined });
      const identity = { owner, chatId: "chat_pg_actions", runId: "run_pg_actions", actionId };
      await expect(recoveredAuthority.invoke({ ...identity, toolId: policy.tools[0]!, arguments: args, executionPolicy: policy, signal: new AbortController().signal })).rejects.toThrow();
      expect(redispatches).toBe(0);
      expect((await recoveredRepository.get(identity)).state).toBe("running");
      const unknownAuthority = createCanonicalActionAuthority({ repository: recoveredRepository, tools: realTools.map((tool) => tool.toolId === policy.tools[0] ? { ...tool, reconcile: undefined } : tool), qualifyPolicy: async () => policy, onEvent: async () => undefined });
      expect((await unknownAuthority.reconcile(identity)).state).toBe("outcome_unknown");
      await expect(recoveredAuthority.invoke({ ...identity, toolId: policy.tools[0]!, arguments: args, executionPolicy: policy, signal: new AbortController().signal })).rejects.toThrow();
      expect(redispatches).toBe(0);
      expect((await recoveredAuthority.reconcile(identity)).state).toBe("succeeded");
      expect((await recoveredRepository.get(identity)).state).toBe("succeeded");
      expect(redispatches).toBe(0);
      expect(await readFile(effectPath, "utf8")).toBe(effectContent);
      expect((await readdir(join(appRoot, "src"))).filter((name) => name === "crash-proof.ts")).toHaveLength(1);
    } finally {
      if (child?.exitCode === null && child.signalCode === null) {
        const exited = new Promise<void>((resolve) => child!.once("exit", () => resolve()));
        child.kill("SIGKILL");
        await Promise.race([exited, new Promise<void>((_, reject) => setTimeout(() => reject(new Error("child cleanup timed out")), 5_000))]);
      }
    }
  }, 30_000);
});
