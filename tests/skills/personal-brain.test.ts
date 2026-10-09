import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, writeFile, readdir, rm, symlink, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const roots: string[] = [];
async function temporary() {
  const root = await mkdtemp(join(tmpdir(), "brain-test-"));
  roots.push(root);
  return root;
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const evidence = {
  service: "notes", account: "local", sourceId: "note-1", title: "Signup experiment",
  text: "Alex proposed simplifying signup. This is an idea, not a confirmed task.",
  observedAt: "2026-10-03T10:00:00Z",
};

describe("personal Brain evidence", () => {
  it("creates a self-contained skill and hooks without altering existing work", async () => {
    const { initializeBrain } = await import("../../skills/matrix/personal-brain/scripts/brain.mjs");
    const root = join(await temporary(), "brain");
    await initializeBrain(root);
    const settings = JSON.parse(await readFile(join(root, ".claude/settings.json"), "utf8"));
    expect(settings.hooks.SessionStart[0].hooks[0].command).toContain("brain-hook.mjs");
    expect(settings.hooks.Stop[0].hooks[0].command).toContain("brain-hook.mjs");
    expect(await readFile(join(root, ".claude/skills/personal-brain/SKILL.md"), "utf8")).toContain("source");
    await writeFile(join(root, "people/alex.md"), "Owner correction: this Alex is a different person.");
    await initializeBrain(root);
    expect(await readFile(join(root, "people/alex.md"), "utf8")).toContain("Owner correction");
    const existing = join(await temporary(), "existing");
    await mkdir(existing);
    await writeFile(join(existing, "work.txt"), "unfinished work");
    await expect(initializeBrain(existing)).rejects.toThrow();
    expect(await readFile(join(existing, "work.txt"), "utf8")).toBe("unfinished work");
  });

  it("deduplicates replays and keeps source revisions and original evidence", async () => {
    const { initializeBrain, captureEvidence } = await import("../../skills/matrix/personal-brain/scripts/brain.mjs");
    const root = join(await temporary(), "brain");
    await initializeBrain(root);
    const first = await captureEvidence(root, evidence);
    const repeat = await captureEvidence(root, { ...evidence, observedAt: "2026-10-04T10:00:00Z" });
    expect(repeat.path).toBe(first.path);
    expect(repeat.created).toBe(false);
    const updated = await captureEvidence(root, { ...evidence, text: "Alex withdrew the signup proposal." });
    expect(updated.path).not.toBe(first.path);
    expect(await readFile(join(root, first.path), "utf8")).toContain(evidence.text);
    expect((await readdir(join(root, "sources"))).filter(name => name.endsWith(".md"))).toHaveLength(2);
    expect((await captureEvidence(root, { ...evidence, account: "another" })).path).not.toBe(first.path);
  });

  it("rejects oversized records, invalid links and symlinked destinations", async () => {
    const { initializeBrain, captureEvidence } = await import("../../skills/matrix/personal-brain/scripts/brain.mjs");
    const root = join(await temporary(), "brain");
    await initializeBrain(root);
    await expect(captureEvidence(root, { ...evidence, text: "x".repeat(150_000) })).rejects.toThrow();
    await expect(captureEvidence(root, { ...evidence, url: "javascript:alert(1)" })).rejects.toThrow();
    await rm(join(root, "sources"), { recursive: true });
    const elsewhere = await temporary();
    await symlink(elsewhere, join(root, "sources"));
    await expect(captureEvidence(root, evidence)).rejects.toThrow();
    expect(await readdir(elsewhere)).toHaveLength(0);
  });

  it("searches source and entity notes with bounded literal matches", async () => {
    const { initializeBrain, captureEvidence, searchBrain } = await import("../../skills/matrix/personal-brain/scripts/brain.mjs");
    const root = join(await temporary(), "brain");
    await initializeBrain(root);
    await captureEvidence(root, evidence);
    await writeFile(join(root, "people/alex.md"), "# Alex\nWorks on signup experiments.\n");
    await writeFile(join(root, ".brain/private.txt"), "signup secret");
    const results = await searchBrain(root, "signup");
    expect(results.map(result => result.path)).toContain("people/alex.md");
    expect(results.some(result => result.path.startsWith("sources/"))).toBe(true);
    expect(results.some(result => result.path.includes("private"))).toBe(false);
    expect(await searchBrain(root, "signup", 1)).toHaveLength(1);
    await expect(searchBrain(root, "")).rejects.toThrow();
  });
});

describe("personal Brain git hooks", () => {
  it("loads installed project context and skips recursive or unrelated hooks", async () => {
    const { initializeBrain } = await import("../../skills/matrix/personal-brain/scripts/brain.mjs");
    const root = join(await temporary(), "brain");
    await initializeBrain(root);
    const hook = join(root, ".claude/skills/personal-brain/scripts/brain-hook.mjs");
    const invoke = (input: unknown) => execFileSync(process.execPath, [hook], {
      cwd: root, encoding: "utf8", input: JSON.stringify(input), timeout: 5000,
    }).trim();
    const context = JSON.parse(invoke({ hook_event_name: "SessionStart", cwd: root }));
    expect(context.hookSpecificOutput.additionalContext).toContain("not configured");
    expect(invoke({ hook_event_name: "Stop", cwd: root, stop_hook_active: true })).toBe("");
    expect(invoke({ hook_event_name: "SessionStart", cwd: await temporary() })).toBe("");
    expect(invoke({ hook_event_name: "Other", cwd: root })).toBe("");
  });

  const git = (root: string, ...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  async function repository() {
    const { initializeBrain } = await import("../../skills/matrix/personal-brain/scripts/brain.mjs");
    const base = await temporary();
    const remote = join(base, "remote.git");
    const root = join(base, "brain");
    git(base, "init", "--bare", "--initial-branch=main", remote);
    await initializeBrain(root);
    git(root, "init", "--initial-branch=main");
    git(root, "config", "user.name", "Brain Test");
    git(root, "config", "user.email", "brain@example.test");
    git(root, "add", ".");
    git(root, "commit", "-m", "feat(brain): initialize pilot");
    git(root, "remote", "add", "origin", remote);
    git(root, "push", "-u", "origin", "main");
    await writeFile(join(root, ".brain/config.json"), JSON.stringify({ version: 1, scope: "personal", repository: "test/brain", autoSync: true }));
    return { root, remote, repositoryInfo: async () => ({ full_name: "test/brain", private: true, clone_url: remote, ssh_url: remote }) };
  }

  it("pushes only Brain markdown and leaves unrelated files and credentials untouched", async () => {
    const { synchronizeBrain } = await import("../../skills/matrix/personal-brain/scripts/brain-sync.mjs");
    const fixture = await repository();
    await writeFile(join(fixture.root, "ideas/signup.md"), "# Signup\nAn experiment.");
    await writeFile(join(fixture.root, ".env"), "PRIVATE_TOKEN=example");
    await writeFile(join(fixture.root, "sources/password.txt"), "unrelated file");
    await synchronizeBrain(fixture.root, "push", fixture.repositoryInfo);
    const paths = git(fixture.remote, "ls-tree", "-r", "--name-only", "HEAD");
    expect(paths).toContain("ideas/signup.md");
    expect(paths).not.toContain(".env");
    expect(paths).not.toContain("password.txt");
    expect(await readFile(join(fixture.root, ".env"), "utf8")).toContain("PRIVATE_TOKEN");
  });

  it("refuses public repositories, changed remotes and unrelated staged changes", async () => {
    const { synchronizeBrain } = await import("../../skills/matrix/personal-brain/scripts/brain-sync.mjs");
    const fixture = await repository();
    const head = git(fixture.remote, "rev-parse", "HEAD");
    await writeFile(join(fixture.root, "ideas/test.md"), "# New idea");
    await expect(synchronizeBrain(fixture.root, "push", async () => ({ ...(await fixture.repositoryInfo()), private: false }))).rejects.toThrow();
    expect(git(fixture.remote, "rev-parse", "HEAD")).toBe(head);
    git(fixture.root, "remote", "set-url", "--push", "origin", join(await temporary(), "other.git"));
    await expect(synchronizeBrain(fixture.root, "push", fixture.repositoryInfo)).rejects.toThrow();
    git(fixture.root, "remote", "set-url", "--push", "origin", fixture.remote);
    await writeFile(join(fixture.root, "unrelated.txt"), "keep staged");
    git(fixture.root, "add", "unrelated.txt");
    await expect(synchronizeBrain(fixture.root, "push", fixture.repositoryInfo)).rejects.toThrow();
    expect(git(fixture.root, "diff", "--cached", "--name-only")).toBe("unrelated.txt");
  });

  it("preserves local edits when startup pull encounters dirty or diverged history", async () => {
    const { synchronizeBrain } = await import("../../skills/matrix/personal-brain/scripts/brain-sync.mjs");
    const fixture = await repository();
    await writeFile(join(fixture.root, "ideas/local.md"), "# Local idea");
    await expect(synchronizeBrain(fixture.root, "pull", fixture.repositoryInfo)).rejects.toThrow();
    expect(await readFile(join(fixture.root, "ideas/local.md"), "utf8")).toBe("# Local idea");
    git(fixture.root, "add", "ideas/local.md");
    git(fixture.root, "commit", "-m", "feat(brain): local idea");
    const other = join(await temporary(), "other");
    git(fixture.root, "clone", fixture.remote, other);
    git(other, "config", "user.name", "Other");
    git(other, "config", "user.email", "other@example.test");
    await writeFile(join(other, "ideas/other.md"), "# Other idea");
    git(other, "add", "ideas/other.md");
    git(other, "commit", "-m", "feat(brain): other idea");
    git(other, "push");
    const head = git(fixture.root, "rev-parse", "HEAD");
    await expect(synchronizeBrain(fixture.root, "pull", fixture.repositoryInfo)).rejects.toThrow();
    expect(git(fixture.root, "rev-parse", "HEAD")).toBe(head);
  });
});
