import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runChatElectronPreview, verifiedSignInSource } from "../../desktop/src/main/chat-electron-preview/executor";

const sourcePath = "desktop/src/renderer/src/features/signin/SignIn.tsx";
const original = '<span className="signin-eyebrow">YOUR SPACE TO BEGIN</span>';
const updated = original.replace("YOUR SPACE TO BEGIN", "YOUR SPACE TO BUILD");
const candidateSha = createHash("sha256").update(updated).digest("hex");
const label = "YOUR SPACE TO BUILD";
const directories = new Set<string>();

afterEach(async () => {
  await Promise.all([...directories].map(path => rm(path, { recursive: true, force: true })));
  directories.clear();
});

async function fixture() {
  const checkout = await mkdtemp(join(tmpdir(), "chat-preview-test-"));
  directories.add(checkout);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: checkout, encoding: "utf8" }).trim();
  git("init", "--quiet");
  const file = join(checkout, sourcePath);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, original);
  git("add", ".");
  git("-c", "user.name=Preview Test", "-c", "user.email=preview@example.invalid", "commit", "--quiet", "-m", "preview fixture");
  return { checkout, file, git, options: { checkout, electronPath: "/missing/test-electron", baseSha: git("rev-parse", "HEAD"),
    sourceSha256: candidateSha, label, signal: new AbortController().signal } };
}

describe("one-shot Electron preview source", () => {
  it("reconstructs exactly the known static label replacement", () => {
    expect(verifiedSignInSource(Buffer.from(original), label, candidateSha)).toEqual(Buffer.from(updated));
  });

  it.each([
    [original, 'GO</span><img onLoad={() => 1}>', candidateSha],
    [`${original}\n${original}`, label, candidateSha],
    [original, label, "a".repeat(64)],
    [original.replace("signin-eyebrow", "other"), label, candidateSha],
    [original, "YOUR SPACE TO BEGIN", candidateSha],
  ])("rejects edits outside its exact source contract", (source, requestedLabel, digest) => {
    expect(() => verifiedSignInSource(Buffer.from(source), requestedLabel, digest)).toThrow();
  });
});

describe("one-shot Electron preview execution", () => {
  it("requires the local checkout to be at the requested trusted revision", async () => {
    const { options, git, file } = await fixture();
    await writeFile(file, `${original}\n`);
    git("add", ".");
    git("-c", "user.name=Preview Test", "-c", "user.email=preview@example.invalid", "commit", "--quiet", "-m", "different trusted head");

    await expect(runChatElectronPreview(options)).rejects.toThrow("trusted local revision");
    expect(await readFile(file, "utf8")).toBe(`${original}\n`);
    expect(git("worktree", "list", "--porcelain").split("\n").filter(line => line.startsWith("worktree "))).toHaveLength(1);
  });

  it("rejects a tracked source symlink and cleans up the detached worktree", async () => {
    const { options, git, file } = await fixture();
    await rm(file);
    await symlink(await realpath(dirname(file)), file);
    git("add", ".");
    git("-c", "user.name=Preview Test", "-c", "user.email=preview@example.invalid", "commit", "--quiet", "-m", "symlink");
    await expect(runChatElectronPreview({ ...options, baseSha: git("rev-parse", "HEAD") })).rejects.toThrow("preview source");
    expect(git("worktree", "list", "--porcelain").split("\n").filter(line => line.startsWith("worktree "))).toHaveLength(1);
  });

  it("does not create a temporary checkout after cancellation", async () => {
    const { options, git } = await fixture();
    await expect(runChatElectronPreview({ ...options, signal: AbortSignal.abort() })).rejects.toThrow();
    expect(git("worktree", "list", "--porcelain").split("\n").filter(line => line.startsWith("worktree "))).toHaveLength(1);
  });
});
