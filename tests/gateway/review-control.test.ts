import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildImplementerPrompt,
  buildReviewerPrompt,
  controlFilePath,
  readReviewControlFile,
  writeReviewControlFile,
} from "../../packages/gateway/src/review-control.js";

describe("review-control", () => {
  let worktreePath: string;

  beforeEach(async () => {
    worktreePath = await mkdtemp(join(tmpdir(), "matrix-review-control-"));
  });

  afterEach(() => {
    rmSync(worktreePath, { recursive: true, force: true });
  });

  it("builds reviewer and implementer prompts with structured output requirements", () => {
    const reviewer = buildReviewerPrompt({
      projectSlug: "repo",
      pr: 42,
      round: 1,
      findingsPath: ".matrix/review-round-1.md",
      controlPath: ".matrix/review-round-1.json",
    });
    expect(reviewer).toContain("## Findings");
    expect(reviewer).toContain("Severity:");
    expect(reviewer).toContain("ready_for_parse");
    expect(reviewer).toContain(".matrix/review-round-1.json");

    const implementer = buildImplementerPrompt({
      projectSlug: "repo",
      pr: 42,
      round: 1,
      findingsPath: ".matrix/review-round-1.md",
      controlPath: ".matrix/review-round-1.json",
    });
    expect(implementer).toContain("implemented");
    expect(implementer).toContain("commit");
    expect(implementer).toContain(".matrix/review-round-1.md");
  });

  it("writes and reads atomic control files under the worktree .matrix directory", async () => {
    const result = await writeReviewControlFile({
      worktreePath,
      round: 1,
      control: {
        status: "ready_for_parse",
        phase: "review",
        round: 1,
        findingsPath: ".matrix/review-round-1.md",
        writtenAt: "2026-04-26T00:00:00.000Z",
      },
    });

    expect(result).toEqual({
      ok: true,
      path: join(worktreePath, ".matrix", "review-round-1.json"),
    });
    await expect(readReviewControlFile({ worktreePath, round: 1 })).resolves.toMatchObject({
      ok: true,
      control: {
        status: "ready_for_parse",
        phase: "review",
        round: 1,
      },
    });
    await expect(stat(join(worktreePath, ".matrix", "review-round-1.json"))).resolves.toMatchObject({
      isFile: expect.any(Function),
    });
  });

  it("validates control file statuses and rejects malformed partial writes", async () => {
    const path = controlFilePath(worktreePath, 2);
    await writeReviewControlFile({
      worktreePath,
      round: 2,
      control: {
        status: "implemented",
        phase: "implement",
        round: 2,
        commit: "abc1234",
        writtenAt: "2026-04-26T00:00:00.000Z",
      },
    });
    await expect(readFile(path, "utf-8")).resolves.toContain("implemented");

    await writeReviewControlFile({
      worktreePath,
      round: 3,
      control: {
        status: "implemented",
        phase: "implement",
        round: 3,
        commit: "abc1234",
        writtenAt: "2026-04-26T00:00:00.000Z",
      },
    });
    await readFile(controlFilePath(worktreePath, 3), "utf-8");
    await expect(readReviewControlFile({ worktreePath, round: 999 })).resolves.toMatchObject({
      ok: false,
      status: 404,
      error: { code: "control_file_missing" },
    });
    await writeFile(path, "{", "utf-8");
    await expect(readReviewControlFile({ worktreePath, round: 2 })).resolves.toMatchObject({
      ok: false,
      status: 400,
      error: { code: "invalid_control_file" },
    });
  });

  it("rejects invalid round numbers before touching the filesystem", async () => {
    expect(() => controlFilePath(worktreePath, 0)).toThrow("Invalid review round");
  });
});
