import { describe, expect, it } from "vitest";
import {
  BatchMoveRequestSchema,
  BatchTrashRequestSchema,
  CreateFileRequestSchema,
  FileManagementNameSchema,
  FileManagementPathSchema,
  FileManagementRequestIdSchema,
  FileOperationResultCodeSchema,
  RenameFileRequestSchema,
} from "../../packages/gateway/src/file-management/contracts.js";

describe("Desktop file-management contracts", () => {
  it("accepts typed create and rename requests with UUID request identifiers", () => {
    const requestId = "a9d9d1d8-8e5d-45d0-8d17-2c85f4e19a11";

    expect(FileManagementRequestIdSchema.safeParse(requestId).success).toBe(true);
    expect(CreateFileRequestSchema.safeParse({
      requestId,
      parentDirectory: "projects/demo",
      name: "notes.md",
      kind: "file",
    }).success).toBe(true);
    expect(RenameFileRequestSchema.safeParse({
      requestId,
      path: "projects/demo/notes.md",
      name: "ideas.md",
    }).success).toBe(true);
  });

  it("bounds normalized batch requests and stable result codes", () => {
    const requestId = "a9d9d1d8-8e5d-45d0-8d17-2c85f4e19a11";
    const sources = ["projects/demo/one.md", "projects/demo/two.md"];

    expect(FileManagementPathSchema.safeParse("projects/demo/one.md").success).toBe(true);
    expect(FileManagementPathSchema.safeParse("../escape").success).toBe(false);
    expect(FileManagementNameSchema.safeParse("draft.md").success).toBe(true);
    expect(FileManagementNameSchema.safeParse("folder/escape").success).toBe(false);
    expect(FileManagementNameSchema.safeParse("x".repeat(256)).success).toBe(false);
    expect(FileManagementPathSchema.safeParse("x".repeat(4_097)).success).toBe(false);

    expect(BatchMoveRequestSchema.safeParse({
      requestId,
      phase: "preflight",
      sources,
      destinationDirectory: "projects/archive",
    }).success).toBe(true);
    expect(BatchMoveRequestSchema.safeParse({
      requestId,
      phase: "execute",
      preflightFingerprint: "opaque-fingerprint",
      conflictChoices: [{ source: sources[0], resolution: "keep-both" }],
    }).success).toBe(true);
    expect(BatchMoveRequestSchema.safeParse({
      requestId,
      phase: "preflight",
      sources: [sources[0], sources[0]],
      destinationDirectory: "projects/archive",
    }).success).toBe(false);
    expect(BatchMoveRequestSchema.safeParse({
      requestId,
      phase: "preflight",
      sources: [sources[0], "projects/other/two.md"],
      destinationDirectory: "projects/archive",
    }).success).toBe(false);
    expect(BatchMoveRequestSchema.safeParse({
      requestId,
      phase: "preflight",
      sources: Array.from({ length: 101 }, (_, index) => `projects/demo/${index}.md`),
      destinationDirectory: "projects/archive",
    }).success).toBe(false);
    expect(BatchTrashRequestSchema.safeParse({ requestId, sources }).success).toBe(true);
    expect(FileOperationResultCodeSchema.safeParse("destination_conflict").success).toBe(true);
    expect(FileOperationResultCodeSchema.safeParse("raw filesystem message").success).toBe(false);
  });
});
