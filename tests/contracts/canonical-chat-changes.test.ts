import {
  CanonicalChatTurnChangeSetSchema,
  CanonicalChatTurnFileReadQuerySchema,
} from "@matrix-os/contracts";
import { describe, expect, it } from "vitest";

const base = {
  chatId: "chat_changes",
  turnId: "cturn_changes",
  runId: "run_changes",
  projectId: "project_matrix",
  executionRoot: { kind: "worktree", projectId: "project_matrix", worktreeId: "wt_abc123def456" },
  revision: `turnrev_${"a".repeat(64)}`,
  beforeRevision: `tree_${"b".repeat(40)}`,
  afterRevision: `tree_${"c".repeat(40)}`,
  source: "workspace_checkpoints",
  label: "Workspace changes observed during this turn",
  concurrent: false,
  partial: false,
  files: [{ path: "src/app.ts", status: "modified", additions: 2, deletions: 1, partial: false }],
  totals: { changedFileCount: 1, additions: 2, deletions: 1 },
  capturedAt: "2026-08-27T04:00:00.000Z",
} as const;

describe("canonical Chat turn-change contracts", () => {
  it("accepts bounded checkpoint changes and preserves rename, binary, partial and concurrent truth", () => {
    expect(CanonicalChatTurnChangeSetSchema.parse(base).files[0]?.path).toBe("src/app.ts");
    expect(CanonicalChatTurnChangeSetSchema.parse({
      ...base,
      label: "Concurrent workspace changes observed during this turn",
      concurrent: true,
      partial: true,
      files: [
        { path: "src/new.ts", previousPath: "src/old.ts", status: "renamed", additions: 0, deletions: 0, partial: false },
        { path: "logo.png", status: "binary", additions: 0, deletions: 0, partial: true },
      ],
      totals: { changedFileCount: 2, additions: 0, deletions: 0 },
    }).files).toHaveLength(2);
  });

  it("rejects traversal, absolute paths, inconsistent rename metadata and dishonest labels", () => {
    for (const path of ["../secret", "/home/matrix/secret", "src/../../secret", "src\\secret"]) {
      expect(CanonicalChatTurnFileReadQuerySchema.safeParse({ path, version: "current" }).success).toBe(false);
    }
    expect(CanonicalChatTurnChangeSetSchema.safeParse({
      ...base,
      files: [{ ...base.files[0], status: "renamed" }],
    }).success).toBe(false);
    expect(CanonicalChatTurnChangeSetSchema.safeParse({
      ...base,
      source: "provider_authoritative",
    }).success).toBe(false);
  });

  it("requires honest no-change and Current file labels through strict enums", () => {
    expect(CanonicalChatTurnChangeSetSchema.parse({
      ...base,
      label: "No workspace changes",
      files: [],
      totals: { changedFileCount: 0, additions: 0, deletions: 0 },
    }).label).toBe("No workspace changes");
    expect(CanonicalChatTurnFileReadQuerySchema.parse({ path: "README.md", version: "current" }))
      .toEqual({ path: "README.md", version: "current" });
    expect(CanonicalChatTurnFileReadQuerySchema.safeParse({
      path: "README.md",
      version: "current",
      ownerId: "other",
    }).success).toBe(false);
  });
});
