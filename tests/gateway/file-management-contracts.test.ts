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

  it("enforces UTF-8 byte limits, conflict-choice bounds, and portable names", () => {
    const requestId = "a9d9d1d8-8e5d-45d0-8d17-2c85f4e19a11";
    const exactly255Bytes = `${"é".repeat(127)}a`;
    const exactly4096Bytes = "é".repeat(2_048);

    expect(FileManagementNameSchema.safeParse(exactly255Bytes).success).toBe(true);
    expect(FileManagementNameSchema.safeParse(`${exactly255Bytes}a`).success).toBe(false);
    expect(FileManagementPathSchema.safeParse(exactly4096Bytes).success).toBe(true);
    expect(FileManagementPathSchema.safeParse(`${exactly4096Bytes}a`).success).toBe(false);

    for (const name of [
      "trailing ",
      "trailing.",
      "bad:name",
      "bad?name",
      "bad*name",
      "bad\"name",
      "bad<name",
      "bad>name",
      "bad|name",
      "CON",
      "com1.txt",
    ]) {
      expect(FileManagementNameSchema.safeParse(name).success, name).toBe(false);
    }

    expect(BatchMoveRequestSchema.safeParse({
      requestId,
      phase: "execute",
      preflightFingerprint: "opaque-fingerprint",
      conflictChoices: Array.from({ length: 101 }, (_, index) => ({
        source: `projects/demo/${index}.md`,
        resolution: "skip" as const,
      })),
    }).success).toBe(false);
  });
});
