import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rename, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ChatTurnChangeCaptureError,
  createChatTurnChangeCapture,
} from "../../packages/gateway/src/chat/turn-changes.js";

const execFileAsync = promisify(execFile);
const created: string[] = [];

async function git(cwd: string, ...args: string[]) {
  await execFileAsync("git", ["-C", cwd, ...args]);
}

async function repository() {
  const root = await mkdtemp(join(tmpdir(), "matrix-chat-turn-changes-"));
  created.push(root);
  await git(root, "init", "-q");
  await git(root, "config", "user.email", "test@example.com");
  await git(root, "config", "user.name", "Matrix Test");
  await writeFile(join(root, "README.md"), "before\n", "utf8");
  await writeFile(join(root, "old.ts"), "export const old = true;\n", "utf8");
  await git(root, "add", ".");
  await git(root, "commit", "-qm", "initial");
  return root;
}

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(created.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("Chat turn checkpoint capture", () => {
  it("isolates changes between checkpoints including rename and binary files", async () => {
    const root = await repository();
    await writeFile(join(root, "README.md"), "pre-existing\n", "utf8");
    const capture = createChatTurnChangeCapture();
    const start = await capture.captureStart(root);

    await writeFile(join(root, "README.md"), "during turn\nsecond line\n", "utf8");
    await rename(join(root, "old.ts"), join(root, "new.ts"));
    await writeFile(join(root, "logo.bin"), Buffer.from([0, 1, 2, 3]));
    const result = await capture.captureFinal({
      root,
      start,
      identity: {
        chatId: "chat_changes",
        turnId: "cturn_changes",
        runId: "run_changes",
        projectId: "project_matrix",
        executionRoot: { kind: "project", projectId: "project_matrix" },
      },
      capturedAt: "2026-08-27T04:00:00.000Z",
    });

    expect(result.changes.source).toBe("workspace_checkpoints");
    expect(result.changes.label).toBe("Workspace changes observed during this turn");
    expect(result.changes.files).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "README.md", status: "modified", additions: 2, deletions: 1 }),
      expect.objectContaining({ path: "new.ts", previousPath: "old.ts", status: "renamed" }),
      expect.objectContaining({ path: "logo.bin", status: "binary", partial: true }),
    ]));
    expect(result.changes.files).not.toContainEqual(expect.objectContaining({ path: "README.md", deletions: 0 }));
    await expect(capture.readDiff({
      root,
      path: "README.md",
      start,
      end: result.end,
      file: result.changes.files.find((file) => file.path === "README.md")!,
    })).resolves.toMatchObject({
      path: "README.md",
      hunks: [expect.objectContaining({
        lines: expect.arrayContaining([
          expect.objectContaining({ kind: "remove", content: "pre-existing" }),
          expect.objectContaining({ kind: "add", content: "during turn" }),
        ]),
      })],
    });
  });

  it("returns an honest no-change set and marks HEAD movement concurrent", async () => {
    const root = await repository();
    const capture = createChatTurnChangeCapture();
    const start = await capture.captureStart(root);
    const noChange = await capture.captureFinal({
      root,
      start,
      identity: {
        chatId: "chat_no_change",
        turnId: "cturn_no_change",
        runId: "run_no_change",
        projectId: "project_matrix",
        executionRoot: { kind: "project", projectId: "project_matrix" },
      },
      capturedAt: "2026-08-27T04:00:00.000Z",
    });
    expect(noChange.changes.label).toBe("No workspace changes");

    await writeFile(join(root, "README.md"), "committed elsewhere\n", "utf8");
    await git(root, "add", ".");
    await git(root, "commit", "-qm", "external");
    const concurrent = await capture.captureFinal({
      root,
      start,
      identity: {
        chatId: "chat_concurrent",
        turnId: "cturn_concurrent",
        runId: "run_concurrent",
        projectId: "project_matrix",
        executionRoot: { kind: "project", projectId: "project_matrix" },
      },
      capturedAt: "2026-08-27T04:01:00.000Z",
    });
    expect(concurrent.changes.concurrent).toBe(true);
    expect(concurrent.changes.label).toBe("Concurrent workspace changes observed during this turn");
  });

  it("reads bounded checkpoint/current text and denies traversal, symlinks and binary content", async () => {
    const root = await repository();
    const capture = createChatTurnChangeCapture({ readLimitBytes: 8 });
    const start = await capture.captureStart(root);
    await writeFile(join(root, "README.md"), "after content longer\n", "utf8");
    const final = await capture.captureFinal({
      root,
      start,
      identity: {
        chatId: "chat_read",
        turnId: "cturn_read",
        runId: "run_read",
        projectId: "project_matrix",
        executionRoot: { kind: "project", projectId: "project_matrix" },
      },
      capturedAt: "2026-08-27T04:00:00.000Z",
    });
    expect(await capture.readFile({ root, path: "README.md", version: "before", start, end: final.end }))
      .toMatchObject({ content: "before\n", label: "Before turn", truncated: false });
    expect(await capture.readFile({ root, path: "README.md", version: "current", start, end: final.end }))
      .toMatchObject({ content: "after co", label: "Current file", truncated: true });

    await symlink("README.md", join(root, "link.md"));
    await mkdir(join(root, "nested"));
    await writeFile(join(root, "binary.bin"), Buffer.from([0, 1, 2]));
    for (const path of ["../secret", "link.md", "binary.bin"]) {
      await expect(capture.readFile({ root, path, version: "current", start, end: final.end }))
        .rejects.toBeInstanceOf(ChatTurnChangeCaptureError);
    }
  });

  it("bounds Git commands by timeout and converts internal failures to safe errors", async () => {
    const root = await mkdtemp(join(tmpdir(), "matrix-chat-turn-timeout-"));
    created.push(root);
    const runGit = vi.fn(async () => await new Promise<string>(() => {}));
    const capture = createChatTurnChangeCapture({ runGit, timeoutMs: 5 });
    await expect(capture.captureStart(root)).rejects.toMatchObject({ code: "capture_unavailable" });
    expect(runGit).toHaveBeenCalledTimes(1);
  });
});
