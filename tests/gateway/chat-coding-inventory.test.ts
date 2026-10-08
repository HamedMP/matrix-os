import { expect, it, vi } from "vitest";
import { createCanonicalActionTools } from "../../packages/gateway/src/chat/action-tools.js";
import { createCanonicalCodingChatProviderAdapter } from "../../packages/gateway/src/chat/coding-provider-adapter.js";
import { freezeCodexCanonicalInventory } from "../../packages/gateway/src/coding-agents/codex-canonical-tools.mjs";
import type { CodingAgentThreadStore } from "../../packages/gateway/src/coding-agents/thread-store.js";
import { createNoteActionTools } from "../../packages/gateway/src/chat/note-action-tool.js";
import type { AppDb } from "../../packages/gateway/src/app-db.js";

it("transports bounded app and Notes schemas while denying data writes in safe-read mode", async () => {
  const inventory = [...createCanonicalActionTools({ homeForOwner: async () => "/unused" }),
    ...createNoteActionTools({ db: {} as AppDb, homeForOwner: async () => "/unused", notify: vi.fn() })];
  const executionPolicy = { revision: "codex_canonical_v1", actionMode: "canonical_actions" as const,
    workspaceScope: "apps", tools: inventory.map(tool => tool.toolId), delegation: false };
  let qualified: ReturnType<typeof freezeCodexCanonicalInventory> | undefined;
  const createThread = vi.fn<CodingAgentThreadStore["createThread"]>(async (_principal, _request, internal) => {
    const execution = internal?.canonicalExecution;
    expect(execution).toBeDefined();
    qualified = freezeCodexCanonicalInventory(execution!.executionPolicy, execution!.inventory);
    throw new Error("validated_without_launch");
  });
  const threads = { createThread, registerEventSink: () => ({ dispose() {} }) } as unknown as CodingAgentThreadStore;
  const adapter = createCanonicalCodingChatProviderAdapter({ providerId: "codex", threads,
    canonical: { inventory, isDispatchLive: () => true } });
  await expect(adapter.start({ owner: { type: "personal", ownerId: "owner_schema" }, chatId: "chat_schema",
    turnId: "cturn_schema", runId: "run_schema", prompt: "List apps", parts: [{ type: "text", text: "List apps" }],
    selection: { instanceId: "codex_default", model: "gpt-test" }, permissionMode: "supervised", interactionMode: "default",
    runPolicy: { memoryMode: "ordinary", source: "voice", nativeCheckpointPolicy: "reusable", executionPolicy },
    signal: new AbortController().signal }).next()).rejects.toThrow("validated_without_launch");
  expect(qualified?.tools).toHaveLength(9);
  expect(qualified?.descriptors.find(tool => tool.toolId === "matrix_create_note")).toMatchObject({ effect: "data" });
  expect(qualified?.descriptors.find(tool => tool.toolId === "matrix_list_notes")).toMatchObject({ effect: "read" });
  expect(qualified?.descriptors.find(tool => tool.toolId === "matrix_edit_note")).toMatchObject({ effect: "data" });
  expect(qualified?.descriptors.find(tool => tool.toolId === "matrix_close_app")).toMatchObject({ effect: "navigation" });
  expect(() => freezeCodexCanonicalInventory({ ...executionPolicy, actionMode: "safe_reads", tools: ["matrix_create_note"] }, qualified!.descriptors)).toThrow();
  const schema = qualified!.descriptors.find(tool => tool.toolId === "matrix_apply_app_files")!.inputSchema;
  expect(schema).toMatchObject({ properties: {
    app: { type: "string", maxLength: 65_536 },
    files: { maxItems: 24, items: { properties: {
      path: { type: "string", maxLength: 160 },
      content: { type: "string", maxLength: 32_768 },
      expectedSha256: { anyOf: [{ type: "string", maxLength: 65_536 }, { type: "null" }] },
    } } },
  } });
  expect(schema).not.toHaveProperty("properties.app.pattern");
});
