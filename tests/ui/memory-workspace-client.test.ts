import { describe, it, expect, vi } from "vitest";
import { createMemoryWorkspaceClient } from "../../packages/ui/src/memory-workspace/client";
import {
  canAddChatMention,
  isChatMention,
} from "../../packages/ui/src/chat-agents/mentions";
import type { CanonicalChatResourceReference } from "@matrix-os/contracts";
describe("memory source handoff and client", () => {
  it("uses canonical authenticated paths and optimistic revision writes", async () => {
    const request = vi.fn().mockResolvedValue({ source: { id: "a" } });
    const client = createMemoryWorkspaceClient({ request });
    await client.getSource("a/b");
    expect(request).toHaveBeenLastCalledWith(
      "GET",
      "/api/memory-workspace/sources/a%2Fb",
    );
    await client.updateSource("a", {
      baseRevision: 1,
      title: "Note",
      content: "Hello",
      collection: "Notes",
    });
    expect(request).toHaveBeenLastCalledWith(
      "PATCH",
      "/api/memory-workspace/sources/a",
      { baseRevision: 1, title: "Note", content: "Hello", collection: "Notes" },
    );
    await client.compare("Hello");
    expect(request).toHaveBeenLastCalledWith(
      "POST",
      "/api/memory-workspace/compare",
      { query: "Hello", limit: 10 },
    );
  });
  it("caps selected memory references and rejects duplicate source IDs", () => {
    const refs = Array.from(
      { length: 8 },
      (_, i) =>
        ({
          kind: "memory_source",
          id: String(i),
          label: "Source",
          revision: "1",
        }) as CanonicalChatResourceReference,
    );
    expect(isChatMention(refs[0]!)).toBe(true);
    expect(canAddChatMention(refs, refs[0]!)).toBe(false);
    expect(canAddChatMention(refs, { ...refs[0]!, id: "new" })).toBe(false);
    expect(
      canAddChatMention(refs.slice(0, 7), { ...refs[0]!, id: "new" }),
    ).toBe(true);
  });
});
