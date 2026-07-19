import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGitLog } from "../../packages/gateway/src/git-log.js";

type RunCommand = (
  command: string,
  args: string[],
  options: { cwd: string; timeout: number },
) => Promise<{ stdout: string; stderr: string }>;

const NOW = "2026-07-19T12:00:00.000Z";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const SHA_C = "c".repeat(40);

function logRecord(fields: { sha: string; parents?: string; author?: string; date?: string; refs?: string; subject?: string }): string {
  return [
    fields.sha,
    fields.parents ?? "",
    fields.author ?? "Alice",
    fields.date ?? "2026-07-19T10:00:00+00:00",
    fields.refs ?? "",
    fields.subject ?? "subject",
  ].join("\x1f") + "\x1e";
}

const SAMPLE_PATCH = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,4 @@
 line1
-old
+new
+added
 line2
diff --git a/new.txt b/new.txt
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/new.txt
@@ -0,0 +1,2 @@
+hello
+world
diff --git a/old.txt b/old.txt
deleted file mode 100644
index 4444444..0000000
--- a/old.txt
+++ /dev/null
@@ -1 +0,0 @@
-bye
diff --git a/name1.txt b/name2.txt
similarity index 90%
rename from name1.txt
rename to name2.txt
index 5555555..6666666 100644
--- a/name1.txt
+++ b/name2.txt
@@ -1 +1 @@
-x
+y
diff --git a/bin.dat b/bin.dat
index 7777777..8888888 100644
Binary files a/bin.dat and b/bin.dat differ
`;

async function seedProject(homePath: string, slug: string, localPath: string): Promise<void> {
  await mkdir(join(homePath, "projects", slug), { recursive: true });
  await writeFile(
    join(homePath, "projects", slug, "config.json"),
    JSON.stringify({ id: "proj_1", name: slug, slug, localPath, addedAt: NOW, updatedAt: NOW }),
  );
}

describe("git-log service", () => {
  let homePath: string;
  let repoPath: string;

  beforeEach(async () => {
    homePath = await mkdtemp(join(tmpdir(), "matrix-git-log-home-"));
    repoPath = await mkdtemp(join(tmpdir(), "matrix-git-log-repo-"));
  });

  afterEach(() => {
    rmSync(homePath, { recursive: true, force: true });
    rmSync(repoPath, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function makeService(runCommand: RunCommand) {
    return createGitLog({ homePath, runCommand, now: () => NOW });
  }

  function probeAwareRunCommand(handlers: {
    log?: { stdout: string } | Error;
    show?: { stdout: string } | Error;
    nameStatus?: { stdout: string } | Error;
    probe?: { stdout: string } | Error;
  }): RunCommand {
    return vi.fn(async (command: string, args: string[]) => {
      expect(command).toBe("git");
      const respond = (value: { stdout: string } | Error) => {
        if (value instanceof Error) throw value;
        return { stdout: value.stdout, stderr: "" };
      };
      if (args[0] === "rev-parse") return respond(handlers.probe ?? { stdout: `${repoPath}\n` });
      if (args[0] === "log") return respond(handlers.log ?? { stdout: "" });
      if (args[0] === "show" && args.includes("--name-status")) {
        return respond(handlers.nameStatus ?? { stdout: "" });
      }
      if (args[0] === "show") return respond(handlers.show ?? { stdout: "" });
      throw new Error(`unexpected git args: ${args.join(" ")}`);
    }) as RunCommand;
  }

  describe("listCommits", () => {
    it("rejects an invalid slug before touching the filesystem", async () => {
      const runCommand = probeAwareRunCommand({});
      const gitLog = makeService(runCommand);

      const result = await gitLog.listCommits("Bad/Slug", { limit: 10, offset: 0 });

      expect(result).toEqual({
        ok: false,
        status: 400,
        error: { code: "invalid_slug", message: "Project slug is invalid" },
      });
      expect(runCommand).not.toHaveBeenCalled();
    });

    it("returns not_found for an unknown project", async () => {
      const gitLog = makeService(probeAwareRunCommand({}));

      const result = await gitLog.listCommits("missing", { limit: 10, offset: 0 });

      expect(result).toEqual({
        ok: false,
        status: 404,
        error: { code: "not_found", message: "Project was not found" },
      });
    });

    it("returns an empty page when the project is not a git repository", async () => {
      await seedProject(homePath, "plain", repoPath);
      const err = Object.assign(new Error("fatal: not a git repository"), {
        stderr: "fatal: not a git repository (or any of the parent directories): .git",
      });
      const gitLog = makeService(probeAwareRunCommand({ probe: err }));

      const result = await gitLog.listCommits("plain", { limit: 10, offset: 0 });

      expect(result).toEqual({ ok: true, commits: [], nextCursor: null, refreshedAt: NOW });
    });

    it("never exposes the Matrix home repository history", async () => {
      await seedProject(homePath, "homeish", homePath);
      const gitLog = makeService(probeAwareRunCommand({ probe: { stdout: `${homePath}\n` } }));

      const result = await gitLog.listCommits("homeish", { limit: 10, offset: 0 });

      expect(result).toEqual({ ok: true, commits: [], nextCursor: null, refreshedAt: NOW });
    });

    it("parses commits with parents, refs, tags, and HEAD markers", async () => {
      await seedProject(homePath, "repo", repoPath);
      const stdout =
        logRecord({ sha: SHA_A, parents: SHA_B, refs: "HEAD -> main, origin/main, tag: v1.0", subject: "Merge feature" }) +
        logRecord({ sha: SHA_B, parents: `${SHA_C} ${SHA_A.slice(0, 39)}d`, author: "Bob", subject: "Work" }) +
        logRecord({ sha: SHA_C, subject: "Initial commit" });
      const gitLog = makeService(probeAwareRunCommand({ log: { stdout } }));

      const result = await gitLog.listCommits("repo", { limit: 200, offset: 0 });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.nextCursor).toBeNull();
      expect(result.refreshedAt).toBe(NOW);
      expect(result.commits).toHaveLength(3);
      expect(result.commits[0]).toEqual({
        sha: SHA_A,
        parents: [SHA_B],
        author: "Alice",
        timestamp: "2026-07-19T10:00:00+00:00",
        subject: "Merge feature",
        refs: ["main", "origin/main"],
        tags: ["v1.0"],
        head: true,
      });
      expect(result.commits[1]).toMatchObject({
        sha: SHA_B,
        parents: [SHA_C, `${SHA_A.slice(0, 39)}d`],
        author: "Bob",
        head: false,
        refs: [],
        tags: [],
      });
      expect(result.commits[2]).toMatchObject({ sha: SHA_C, parents: [] });
    });

    it("passes limit and skip to git log and pages with a cursor", async () => {
      await seedProject(homePath, "repo", repoPath);
      const runCommand = probeAwareRunCommand({ log: { stdout: logRecord({ sha: SHA_A }) } });
      const gitLog = makeService(runCommand);

      const result = await gitLog.listCommits("repo", { limit: 1, offset: 40 });

      expect(result).toMatchObject({ ok: true, nextCursor: "41" });
      const logCall = (runCommand as ReturnType<typeof vi.fn>).mock.calls.find((call) => call[1][0] === "log");
      expect(logCall).toBeDefined();
      const args = logCall![1] as string[];
      expect(args).toContain("--all");
      const nIndex = args.indexOf("-n");
      expect(args[nIndex + 1]).toBe("1");
      expect(args.join(" ")).toContain("--skip=40");
    });

    it("treats an empty repository as an empty page", async () => {
      await seedProject(homePath, "repo", repoPath);
      const err = Object.assign(new Error("fatal: your current branch 'main' does not have any commits yet"), {
        stderr: "fatal: your current branch 'main' does not have any commits yet",
      });
      const gitLog = makeService(probeAwareRunCommand({ log: err }));

      const result = await gitLog.listCommits("repo", { limit: 10, offset: 0 });

      expect(result).toEqual({ ok: true, commits: [], nextCursor: null, refreshedAt: NOW });
    });

    it("maps unexpected git failures to a generic 502", async () => {
      await seedProject(homePath, "repo", repoPath);
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const gitLog = makeService(probeAwareRunCommand({ log: new Error("spawn git ENOENT") }));

      const result = await gitLog.listCommits("repo", { limit: 10, offset: 0 });

      expect(result).toEqual({
        ok: false,
        status: 502,
        error: { code: "git_request_failed", message: "Git request failed" },
      });
      expect(warn).toHaveBeenCalled();
    });
  });

  describe("getCommitDiff", () => {
    it("rejects an invalid commit sha before shelling out", async () => {
      await seedProject(homePath, "repo", repoPath);
      const runCommand = probeAwareRunCommand({});
      const gitLog = makeService(runCommand);

      const result = await gitLog.getCommitDiff("repo", "not a sha!", { maxFiles: 10, maxLines: 100 });

      expect(result).toEqual({
        ok: false,
        status: 400,
        error: { code: "invalid_sha", message: "Commit identifier is invalid" },
      });
      expect(runCommand).not.toHaveBeenCalled();
    });

    it("parses per-file patches with statuses and line counts", async () => {
      await seedProject(homePath, "repo", repoPath);
      const gitLog = makeService(probeAwareRunCommand({ show: { stdout: SAMPLE_PATCH } }));

      const result = await gitLog.getCommitDiff("repo", SHA_A, { maxFiles: 200, maxLines: 400 });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.truncated).toBe(false);
      expect(result.files).toHaveLength(5);
      const [modified, added, deleted, renamed, binary] = result.files;
      expect(modified).toMatchObject({ path: "src/a.ts", oldPath: null, status: "M", additions: 2, deletions: 1, binary: false, truncated: false });
      expect(modified?.patch).toContain("@@ -1,3 +1,4 @@");
      expect(modified?.patch).toContain("+added");
      expect(modified?.patch).not.toContain("diff --git");
      expect(added).toMatchObject({ path: "new.txt", status: "A", additions: 2, deletions: 0 });
      expect(deleted).toMatchObject({ path: "old.txt", status: "D", additions: 0, deletions: 1 });
      expect(renamed).toMatchObject({ path: "name2.txt", oldPath: "name1.txt", status: "R", additions: 1, deletions: 1 });
      expect(binary).toMatchObject({ path: "bin.dat", binary: true, patch: null, additions: null, deletions: null });
    });

    it("caps the file list and marks the result truncated", async () => {
      await seedProject(homePath, "repo", repoPath);
      const gitLog = makeService(probeAwareRunCommand({ show: { stdout: SAMPLE_PATCH } }));

      const result = await gitLog.getCommitDiff("repo", SHA_A, { maxFiles: 2, maxLines: 400 });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.files).toHaveLength(2);
      expect(result.truncated).toBe(true);
    });

    it("caps per-file patch lines", async () => {
      await seedProject(homePath, "repo", repoPath);
      const gitLog = makeService(probeAwareRunCommand({ show: { stdout: SAMPLE_PATCH } }));

      const result = await gitLog.getCommitDiff("repo", SHA_A, { maxFiles: 200, maxLines: 50 });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const modified = result.files[0];
      expect(modified?.truncated).toBe(false);
      expect(result.truncated).toBe(false);
    });

    it("truncates files whose patch exceeds the per-file line cap", async () => {
      await seedProject(homePath, "repo", repoPath);
      const bigHunk = ["@@ -1,200 +1,200 @@"];
      for (let i = 0; i < 120; i += 1) bigHunk.push(`-old ${i}`, `+new ${i}`);
      const patch = `diff --git a/big.txt b/big.txt
index 1111111..2222222 100644
--- a/big.txt
+++ b/big.txt
${bigHunk.join("\n")}
`;
      const gitLog = makeService(probeAwareRunCommand({ show: { stdout: patch } }));

      const result = await gitLog.getCommitDiff("repo", SHA_A, { maxFiles: 200, maxLines: 50 });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.files).toHaveLength(1);
      const file = result.files[0]!;
      expect(file.truncated).toBe(true);
      expect(file.patch?.split("\n")).toHaveLength(50);
      expect(file.additions).toBe(120);
      expect(file.deletions).toBe(120);
      expect(result.truncated).toBe(true);
    });

    it("falls back to a name-status listing when the patch exceeds the buffer", async () => {
      await seedProject(homePath, "repo", repoPath);
      const maxBufferErr = Object.assign(new Error("stdout maxBuffer length exceeded"), { code: "ERR_OUT_OF_RANGE" });
      const nameStatus = `M\0src/a.ts\0R100\0name1.txt\0name2.txt\0`;
      const gitLog = makeService(probeAwareRunCommand({ show: maxBufferErr, nameStatus: { stdout: nameStatus } }));

      const result = await gitLog.getCommitDiff("repo", SHA_A, { maxFiles: 200, maxLines: 400 });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.truncated).toBe(true);
      expect(result.files).toEqual([
        { path: "src/a.ts", oldPath: null, status: "M", additions: null, deletions: null, binary: false, patch: null, truncated: true },
        { path: "name2.txt", oldPath: "name1.txt", status: "R", additions: null, deletions: null, binary: false, patch: null, truncated: true },
      ]);
    });

    it("maps an unknown commit to a 404", async () => {
      await seedProject(homePath, "repo", repoPath);
      const err = Object.assign(new Error("fatal: bad object deadbeef"), { stderr: "fatal: bad object deadbeef" });
      const gitLog = makeService(probeAwareRunCommand({ show: err, nameStatus: err }));

      const result = await gitLog.getCommitDiff("repo", SHA_A, { maxFiles: 200, maxLines: 400 });

      expect(result).toEqual({
        ok: false,
        status: 404,
        error: { code: "not_found", message: "Commit was not found" },
      });
    });

    it("returns an empty diff for projects without a git repository", async () => {
      await seedProject(homePath, "plain", repoPath);
      const err = Object.assign(new Error("fatal: not a git repository"), {
        stderr: "fatal: not a git repository (or any of the parent directories): .git",
      });
      const gitLog = makeService(probeAwareRunCommand({ probe: err }));

      const result = await gitLog.getCommitDiff("plain", SHA_A, { maxFiles: 200, maxLines: 400 });

      expect(result).toEqual({ ok: true, files: [], truncated: false, refreshedAt: NOW });
    });

    it("maps unexpected show failures to a generic 502", async () => {
      await seedProject(homePath, "repo", repoPath);
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const gitLog = makeService(probeAwareRunCommand({ show: new Error("killed"), nameStatus: new Error("killed") }));

      const result = await gitLog.getCommitDiff("repo", SHA_A, { maxFiles: 200, maxLines: 400 });

      expect(result).toEqual({
        ok: false,
        status: 502,
        error: { code: "git_request_failed", message: "Git request failed" },
      });
      expect(warn).toHaveBeenCalled();
    });
  });
});
