import { expect, it } from "vitest";
import { memoryContextChatReferences } from "../../packages/ui/src/memory-workspace/chat-references";

it("derives the same bounded, ordered Memory selection and revision receipts for every surface", () => {
  const sources = Array.from({ length: 30 }, (_, i) => ({
    sourceId: String(i), revision: i + 1, title: `${i} ${"x".repeat(300)}`,
  }));
  const references = memoryContextChatReferences({ sources });
  expect(references).toHaveLength(8);
  expect(references.map(ref => ref.id)).toEqual(["0", "1", "2", "3", "4", "5", "6", "7"]);
  expect(references[0]).toEqual({ kind: "memory_source", id: "0", revision: "1", label: sources[0]!.title.slice(0, 280) });
  expect(references[7]!.revision).toBe("8");
  expect(sources).toHaveLength(30);
});

it("fails closed when no canonical originals survived context resolution", () => {
  expect(() => memoryContextChatReferences({ sources: [] })).toThrow("context_unavailable");
});
