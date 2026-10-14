import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { createOwnerAppDataReadRuntime } from "../../packages/gateway/src/startup/owner-app-data-read.js";
import { createClaudeChatProviderAdapter } from "../../packages/gateway/src/chat/claude-provider-adapter.js";
import { readFile } from "node:fs/promises";
import { ownerReadFixture, OWNER, RUN, RUNTIME, READ_PATH, MACHINE_SECRET, DATABASE_SECRET } from "./owner-app-data-read-fixture.js";

describe("ENG-289 production owner read composition", () => {
  it("wires the tested services into startup, native grant resolution and auth", async () => {
    const source = await readFile(new URL("../../packages/gateway/src/server.ts", import.meta.url), "utf8");
    expect(source).toContain("createOwnerAppDataReadRuntime({ apps: appRegistry");
    expect(source).toContain("ownerAppDataRead: ownerAppDataRead.auth");
    expect(source).toContain("ownerAppDataRead?.register(app)");
    expect(source).toContain("resolveAppDataReadGrant: ownerAppDataRead.resolveGrant");
  });
  it("validates dependencies at registration and supplies only server-derived installed grants", async () => {
    const f = await ownerReadFixture();
    await expect(createOwnerAppDataReadRuntime({ apps: null, queryEngine: f.engine, kysely: f.kysely,
      ownerId: OWNER.ownerId, runtimeHandle: RUNTIME })).rejects.toThrow("App read dependencies unavailable");
    const runtime = await createOwnerAppDataReadRuntime({ apps: f.apps, queryEngine: f.engine,
      kysely: f.kysely, ownerId: OWNER.ownerId, runtimeHandle: RUNTIME });
    expect(await runtime.resolveGrant({ ...OWNER, ownerId: "someone_else" })).toBeNull();
    expect(await runtime.resolveGrant(OWNER)).toMatchObject({ runtimeHandle: RUNTIME,
      apps: expect.arrayContaining([{ app: "notes", schema: "notes", tables: ["entries", "restricted"] }]) });
    await runtime.audit({ ownerId: OWNER.ownerId, runId: RUN, runtimeHandle: RUNTIME, app: "notes", action: "find", outcome: "allowed" });
    const result = await f.kysely.selectFrom("_app_data_read_audit").select("event").execute();
    expect(result).toHaveLength(1);
    expect(result[0]!.event).toMatchObject({ runId: RUN, outcome: "allowed" });
  });

  it("delegates app reads to the actual native process without DB/machine credentials, then revokes", async () => {
    const f = await ownerReadFixture();
    const runtime = await createOwnerAppDataReadRuntime({ apps: f.apps, queryEngine: f.engine,
      kysely: f.kysely, ownerId: OWNER.ownerId, runtimeHandle: RUNTIME });
    const spawnFn = vi.fn(() => {
      const child = new EventEmitter();
      const stdout = new EventEmitter(), stderr = new EventEmitter();
      return Object.assign(child, { stdout, stderr, kill: vi.fn(), stdin: {
        write(line: string, callback?: (error?: Error | null) => void) {
          callback?.();
          if (JSON.parse(line).type === "user") queueMicrotask(() => {
            stdout.emit("data", Buffer.from(JSON.stringify({ type: "result", subtype: "success", result: "safe", session_id: "session_fixture" }) + "\n"));
            child.emit("exit", 0, null);
          });
          return true;
        },
      } });
    });
    const issued = vi.spyOn(f.capabilities, "issue");
    const adapter = createClaudeChatProviderAdapter({ homePath: "/safe/home", spawnFn,
      resolveCredentialEnv: async () => ({ MATRIX_AUTH_TOKEN: MACHINE_SECRET, DATABASE_URL: DATABASE_SECRET, PGPASSWORD: "db-secret" }),
      matrixMcpCapabilityIssuer: f.capabilities, resolveAppDataReadGrant: runtime.resolveGrant });
    for await (const _ of adapter.start({ owner: OWNER, chatId: "chat_fixture", turnId: "cturn_fixture", runId: "run_native",
      prompt: "Read my app", parts: [{ type: "text", text: "Read my app" }],
      selection: { instanceId: "claude_code_default", model: "claude-haiku-4-5" },
      interactionMode: "default", permissionMode: "supervised", signal: new AbortController().signal,
    })) { /* Drain the production adapter. */ }
    expect(issued).toHaveBeenCalledWith(expect.objectContaining({ appDataRead: expect.objectContaining({ runtimeHandle: RUNTIME }) }));
    const env = (spawnFn.mock.calls as unknown as Array<[string, string[], { env: Record<string, string> }]>)[0]![2].env;
    expect(env.MATRIX_AGENT_INTEGRATIONS_TOKEN).toMatch(/^[a-f0-9]{64}$/);
    expect(env).not.toHaveProperty("DATABASE_URL");
    expect(env).not.toHaveProperty("PGPASSWORD");
    expect(env).not.toHaveProperty("MATRIX_AUTH_TOKEN");
    expect(f.capabilities.resolve(env.MATRIX_AGENT_INTEGRATIONS_TOKEN!, "POST", READ_PATH)).toBeNull();
  });
});
