import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { KyselyPGlite } from "kysely-pglite";
import { ChatMemorySnapshotSchema, CanonicalChatResourceReferenceSchema } from "@matrix-os/contracts";
import { MemoryWorkspaceRepository } from "../../packages/gateway/src/memory-workspace/repository";
import { MemoryWorkspaceService } from "../../packages/gateway/src/memory-workspace/service";
import { memoryContextChatReferences } from "../../packages/ui/src/memory-workspace/chat-references";
import { ChatAgentContext } from "../../packages/gateway/src/chat/agent-context";
let repo: MemoryWorkspaceRepository;
beforeEach(async () => { repo = new MemoryWorkspaceRepository((await KyselyPGlite.create()).dialect); await repo.bootstrap(); });
afterEach(async () => { await repo.destroy(); });

it.each(["password=notes", "Notes about /tmp/cache", "token: notes"])(
  "resolves %s as safe Chat receipts without altering its owned original", async title => {
    const { sources: [source] } = await repo.importSources("alice", {
      clientRequestId: "title", sources: [{ externalId: "source", title, content: "Owner-controlled original text", kind: "note", collection: "Notes" }],
    });
    const service = new MemoryWorkspaceService(repo, {});
    const context = await service.context("alice", [source!.id]);
    expect(context.sources[0]!.title).toBe(title);
    const [reference] = memoryContextChatReferences(context);
    const [snapshot] = await service.resolveChat("alice", [{ id: source!.id, revision: source!.revision }]);
    expect(snapshot!.title).toBe("Memory source");
    expect(snapshot!.title).toBe(reference!.label);
    expect(ChatMemorySnapshotSchema.safeParse(snapshot).success).toBe(true);
    expect(snapshot!.text).toBe(source!.content);
    const chat = new ChatAgentContext({
      repository: {
        getDetailPage: vi.fn().mockResolvedValue({ record: { chat: { lifecycle: "active", title: "Chat" } }, messages: [], runs: [] }),
        get: vi.fn(),
      },
      agents: { get: vi.fn() }, enabled: () => true,
      memories: {
        resolve: (owner, refs) => service.resolveChat(owner.ownerId, refs.map(ref => ({ id: ref.id, revision: Number(ref.revision) }))),
        revalidate: (owner, snapshots) => service.revalidateChat(owner.ownerId, snapshots),
      },
    });
    const prepared = await chat.prepare({ type: "personal", ownerId: "alice" }, "chat_current", {
      clientRequestId: "req_title_turn", baseRevision: 0,
      selection: { instanceId: "codex_default", model: "default" },
      interactionMode: "default", permissionMode: "read_only",
      parts: [{ type: "text", text: "Summarize" }, { type: "resource_reference", resource: reference! }],
    });
    expect(prepared.context!.memories).toEqual([snapshot]);
    expect(await repo.getSource("alice", source!.id)).toMatchObject({ title, content: source!.content, revision: 1 });
    await expect(service.revalidateChat("alice", [snapshot!])).resolves.toBeUndefined();
  },
);

it("preserves a safe long or multiline original in Library and derives the same bounded Chat title", async () => {
  const title = `Calendar\n${"x".repeat(280)}`;
  const { sources: [source] } = await repo.importSources("alice", {
    clientRequestId: "long-title", sources: [{ externalId: "source", title, content: "Original content", kind: "calendar", collection: "Calendar" }],
  });
  const service = new MemoryWorkspaceService(repo, {});
  const [snapshot] = await service.resolveChat("alice", [{ id: source!.id, revision: 1 }]);
  const [reference] = memoryContextChatReferences(await service.context("alice", [source!.id]));
  expect(snapshot!.title).toBe(title.slice(0, 280));
  expect(snapshot!.title).toBe(reference!.label);
  expect(ChatMemorySnapshotSchema.safeParse(snapshot).success).toBe(true);
  expect((await repo.getSource("alice", source!.id))!.title).toBe(title);
});

it("keeps unsafe-label guards strict at reference and snapshot boundaries", () => {
  expect(CanonicalChatResourceReferenceSchema.safeParse({ kind: "memory_source", id: "11111111-1111-4111-8111-111111111111", revision: "1", label: "password=notes" }).success).toBe(false);
  expect(ChatMemorySnapshotSchema.safeParse({ sourceId: "11111111-1111-4111-8111-111111111111", revision: 1, title: "password=notes", text: "Original text", truncated: false }).success).toBe(false);
});
