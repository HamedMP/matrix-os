import { describe, expect, it } from "vitest";
import {
  MemoryImportRequestSchema,
  MemorySourcePatchSchema,
  MemoryContextRequestSchema,
} from "../../packages/contracts/src/memory-workspace.js";
describe("memory workspace contracts", () => {
  const source = {
    externalId: "note:1",
    title: "Note",
    content: "My project",
    kind: "note",
    collection: "Notes",
  };
  it("accepts bounded source batches and rejects unknown fields and duplicate external IDs", () => {
    expect(
      MemoryImportRequestSchema.safeParse({
        clientRequestId: "one",
        sources: [source],
      }).success,
    ).toBe(true);
    expect(
      MemoryImportRequestSchema.safeParse({
        clientRequestId: "one",
        sources: [source, source],
      }).success,
    ).toBe(false);
    expect(
      MemoryImportRequestSchema.safeParse({
        clientRequestId: "one",
        sources: [{ ...source, owner: "bob" }],
      }).success,
    ).toBe(false);
  });
  it("requires revision edits and bounds context selection", () => {
    expect(
      MemorySourcePatchSchema.safeParse({ content: "updated" }).success,
    ).toBe(false);
    expect(MemorySourcePatchSchema.safeParse({ baseRevision: 1 }).success).toBe(
      false,
    );
    expect(
      MemoryContextRequestSchema.safeParse({
        sourceIds: Array(31).fill("00000000-0000-4000-8000-000000000000"),
      }).success,
    ).toBe(false);
  });
});
