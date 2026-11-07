import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BotToolRequestSchema, GithubDeveloperActionSchema } from "@matrix-os/contracts";
import { createBotToolDispatcher, sweepBotWorkspaceSaves } from "../../../packages/gateway/src/bots/tool-dispatcher.js";
import { ARTIFACT_RECOVERY_DIRECTORY } from "../../../packages/gateway/src/bots/artifact-replacement.js";
import type { ManagedPiRuntimeBinding } from "../../../packages/gateway/src/bots/runtime-registry.js";
import { ensureBotWorkspace } from "../../../packages/gateway/src/bots/instantiation.js";
import { resolveBotWorkspaceRoot } from "../../../packages/gateway/src/chat/bot-workspace-root.js";

vi.mock("node:fs/promises", async original => {
  const actual = await original<typeof fs>();
  return { ...actual, rename: vi.fn(actual.rename), link: vi.fn(actual.link), open: vi.fn(actual.open) };
});
const exec = promisify(execFile);
let home: string; let root: string;
const signal = () => new AbortController().signal;
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const binding = { kind: "managed_chat", ownerId: "user_owner", chatId: "chat_replace", runId: "run_replace",
  runtimeHandle: `runtime_${"a".repeat(32)}`, executionGeneration: "1", rootFingerprint: "a".repeat(64),
  capabilities: ["artifact.write", "artifact.read"], requestClass: "interactive", workspace: { kind: "chat_workspace" } } as ManagedPiRuntimeBinding;
const request = (content: string, expectedSha256 = digest("original\n")) => BotToolRequestSchema.parse({
  toolCallId: "replace_file", capability: "artifact.write", args: { relPath: "repo/tracked.txt", content,
    mimeType: "text/plain", replace: { expectedSha256 } },
});
const tools = (assertSource?: () => Promise<void>) => createBotToolDispatcher({ homePath: home, managedWorkspace: async () => root, assertSource });
const target = () => join(root, "repo", "tracked.txt");
async function recovery() {
  const path = join(home, ARTIFACT_RECOVERY_DIRECTORY);
  const slots = await fs.readdir(path);
  return Promise.all(slots.map(async slot => ({ id: slot, content: await fs.readFile(join(path, slot, "previous"), "utf8"), info: JSON.parse(await fs.readFile(join(path, slot, "record.json"), "utf8")) })));
}
beforeEach(async () => {
  const actual = await vi.importActual<typeof fs>("node:fs/promises");
  vi.mocked(fs.rename).mockReset().mockImplementation(actual.rename);
  vi.mocked(fs.link).mockReset().mockImplementation(actual.link);
  vi.mocked(fs.open).mockReset().mockImplementation(actual.open);
  home = await fs.mkdtemp(join(tmpdir(), "artifact-replace-")); root = join(home, "workspace");
  await fs.mkdir(join(root, "repo"), { recursive: true }); await fs.writeFile(target(), "original\n");
});
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(home, { recursive: true, force: true }); });

it("reads an exact digest and edits an existing tracked file while retaining its displaced inode", async () => {
  const repo = join(root, "repo"); await exec("git", ["init", "-b", "main"], { cwd: repo });
  await exec("git", ["add", "tracked.txt"], { cwd: repo });
  await exec("git", ["-c", "user.name=Seed", "-c", "user.email=seed@example.com", "commit", "-m", "seed"], { cwd: repo });
  await fs.chmod(target(), 0o750);
  const before = await fs.stat(target());
  const dispatcher = tools();
  const read = BotToolRequestSchema.parse({ toolCallId: "read_hash", capability: "artifact.read", args: { relPath: "repo/tracked.txt", withHash: true } });
  const result = await dispatcher.dispatch(binding, read, signal());
  expect(JSON.parse(result.result.ok ? result.result.content[0]!.text : "{}")).toMatchObject({ content: "original\n", sha256: digest("original\n"), size: 9 });
  await expect(dispatcher.dispatch(binding, request("edited\n"), signal())).resolves.toMatchObject({ result: { ok: true } });
  expect(await fs.readFile(target(), "utf8")).toBe("edited\n");
  expect((await fs.stat(target())).mode & 0o777).toBe(0o750);
  expect((await exec("git", ["diff", "--", "tracked.txt"], { cwd: repo })).stdout).toContain("+edited");
  const saved = await recovery(); expect(saved).toHaveLength(1); expect(saved[0]!.content).toBe("original\n");
  expect((await fs.stat(join(home, ARTIFACT_RECOVERY_DIRECTORY, saved[0]!.id, "previous"))).ino).toBe(before.ino);
  await sweepBotWorkspaceSaves(home, Date.now() + 24 * 60 * 60_000);
  expect((await recovery())[0]!.content).toBe("original\n");
});

it("refuses stale expected bytes before capture and leaves the target unchanged", async () => {
  await fs.writeFile(target(), "Terminal edit\n");
  await expect(tools().dispatch(binding, request("model edit\n"), signal())).rejects.toMatchObject({ code: "artifact_digest_mismatch" });
  expect(await fs.readFile(target(), "utf8")).toBe("Terminal edit\n"); expect(fs.rename).not.toHaveBeenCalled();
});

it("retains later writes through an already-open Terminal file descriptor", async () => {
  const file = await fs.open(target(), "r+");
  try {
    await tools().dispatch(binding, request("model edit\n"), signal());
    await file.truncate(0);
    await file.writeFile("late Terminal edit\n");
    expect(await fs.readFile(target(), "utf8")).toBe("model edit\n");
    expect((await recovery())[0]!.content).toBe("late Terminal edit\n");
  } finally { await file.close(); }
});

it("preserves a concurrent mode change at capture instead of replacing it", async () => {
  await fs.chmod(target(), 0o640);
  const actual = await vi.importActual<typeof fs>("node:fs/promises");
  vi.mocked(fs.rename).mockImplementationOnce(async (from, to) => { await fs.chmod(from, 0o750); await actual.rename(from, to); });
  await expect(tools().dispatch(binding, request("model edit\n"), signal())).rejects.toMatchObject({ name: "ArtifactRecoveryRequired" });
  expect(await fs.readFile(target(), "utf8")).toBe("original\n");
  expect((await fs.stat(target())).mode & 0o777).toBe(0o750);
});

it("cleans an empty reservation after pre-capture authority refusal", async () => {
  await expect(tools(async () => { throw new Error("revoked before capture"); }).dispatch(binding, request("model edit\n"), signal())).rejects.toThrow("revoked before capture");
  expect(await fs.readFile(target(), "utf8")).toBe("original\n");
  expect(await fs.readdir(join(home, ARTIFACT_RECOVERY_DIRECTORY))).toEqual([]);
  expect(fs.rename).not.toHaveBeenCalled();
});

it("does not capture when cancellation arrives during the final authority await", async () => {
  const controller = new AbortController();
  await expect(tools(async () => { controller.abort(); }).dispatch(binding, request("model edit\n"), controller.signal))
    .rejects.toMatchObject({ code: "stale_generation" });
  expect(fs.rename).not.toHaveBeenCalled();
  expect(await fs.readFile(target(), "utf8")).toBe("original\n");
  expect(await fs.readdir(join(home, ARTIFACT_RECOVERY_DIRECTORY))).toEqual([]);
});

it("syncs Native Bot replacement bytes before capturing the owner's existing file", async () => {
  const botId = "bot_0123456789abcdef01234567";
  await ensureBotWorkspace(home, botId);
  const resolved = await resolveBotWorkspaceRoot({ homePath: home,
    owner: { type: "personal", ownerId: binding.ownerId }, ref: { kind: "bot_workspace", botId } });
  const native = { ...binding, kind: undefined, botId, taskId: "task_native", rootFingerprint: resolved.fingerprint } as never;
  const nativeTarget = join(resolved.primaryWorkspaceRoot, "repo", "tracked.txt");
  await fs.mkdir(join(resolved.primaryWorkspaceRoot, "repo"));
  await fs.writeFile(nativeTarget, "original\n");
  const actual = await vi.importActual<typeof fs>("node:fs/promises");
  vi.mocked(fs.open).mockImplementation(async (...args) => {
    const file = await actual.open(...args);
    if (String(args[0]).endsWith(".tmp")) vi.spyOn(file, "sync").mockRejectedValue(new Error("staged sync failed"));
    return file;
  });
  await expect(createBotToolDispatcher({ homePath: home }).dispatch(native, request("model edit\n"), signal()))
    .rejects.toThrow("staged sync failed");
  expect(fs.rename).not.toHaveBeenCalled();
  expect(await fs.readFile(nativeTarget, "utf8")).toBe("original\n");
});

it("refuses target symlinks and a symlinked recovery directory without changing outside bytes", async () => {
  const outside = join(home, "outside.txt"); await fs.writeFile(outside, "outside\n");
  await fs.unlink(target()); await fs.symlink(outside, target());
  await expect(tools().dispatch(binding, request("model edit\n", digest("outside\n")), signal())).rejects.toMatchObject({ code: "invalid_arguments" });
  expect(await fs.readFile(outside, "utf8")).toBe("outside\n");
  await fs.unlink(target()); await fs.writeFile(target(), "original\n");
  const outsideDirectory = join(home, "outside-directory"); await fs.mkdir(outsideDirectory);
  await fs.symlink(outsideDirectory, join(home, ARTIFACT_RECOVERY_DIRECTORY));
  await expect(tools().dispatch(binding, request("model edit\n"), signal())).rejects.toMatchObject({ code: "unavailable" });
  expect(await fs.readdir(outsideDirectory)).toEqual([]);
  expect(await fs.readFile(target(), "utf8")).toBe("original\n");
});

it("preserves a Terminal edit occurring at capture and classifies the result as recovery/unknown", async () => {
  const actual = await vi.importActual<typeof fs>("node:fs/promises");
  vi.mocked(fs.rename).mockImplementationOnce(async (from, to) => { await fs.writeFile(from, "Terminal at capture\n"); await actual.rename(from, to); });
  await expect(tools().dispatch(binding, request("model edit\n"), signal())).rejects.toMatchObject({ name: "ArtifactRecoveryRequired" });
  expect(await fs.readFile(target(), "utf8")).toBe("Terminal at capture\n"); expect((await recovery())[0]!.content).toBe("Terminal at capture\n");
});

it("never overwrites a concurrent path recreation after capture", async () => {
  const actual = await vi.importActual<typeof fs>("node:fs/promises");
  vi.mocked(fs.link).mockImplementationOnce(async (from, to) => { await fs.writeFile(to, "Terminal recreated\n"); await actual.link(from, to); });
  await expect(tools().dispatch(binding, request("model edit\n"), signal())).rejects.toMatchObject({ name: "ArtifactRecoveryRequired" });
  expect(await fs.readFile(target(), "utf8")).toBe("Terminal recreated\n"); expect((await recovery())[0]!.content).toBe("original\n");
});

it.each(["source revocation", "cancellation"])("retains captured bytes on post-capture %s and restores only exclusively", async cause => {
  let calls = 0;
  const controller = new AbortController();
  await expect(tools(async () => {
    if (++calls === 2) {
      if (cause === "cancellation") controller.abort();
      else throw new Error("revoked");
    }
  }).dispatch(binding, request("model edit\n"), controller.signal)).rejects.toMatchObject({ name: "ArtifactRecoveryRequired" });
  expect(await fs.readFile(target(), "utf8")).toBe("original\n"); expect((await recovery())[0]!.content).toBe("original\n");
});

it("fails closed at 64 owner recovery slots and never exposes reserved metadata paths", async () => {
  const path = join(home, ARTIFACT_RECOVERY_DIRECTORY); await fs.mkdir(path, { mode: 0o700 });
  for (let index = 0; index < 64; index++) await fs.mkdir(join(path, `slot-${String(index).padStart(2, "0")}`), { mode: 0o700 });
  await expect(tools().dispatch(binding, request("model edit\n"), signal())).rejects.toMatchObject({ code: "unavailable" });
  expect(await fs.readFile(target(), "utf8")).toBe("original\n"); expect(fs.rename).not.toHaveBeenCalled();
  for (const relPath of [`${ARTIFACT_RECOVERY_DIRECTORY}/slot-00/record.json`, `repo/${ARTIFACT_RECOVERY_DIRECTORY}/previous`, "repo/.git/config"]) {
    await expect(tools().dispatch(binding, { toolCallId: "read_reserved", capability: "artifact.read", args: { relPath } } as never, signal())).rejects.toMatchObject({ code: "invalid_arguments" });
  }
  expect(GithubDeveloperActionSchema.safeParse({ action: "commit", path: "repo", expectedHead: "a".repeat(40),
    files: [`${ARTIFACT_RECOVERY_DIRECTORY}/slot-00/record.json`], message: "must not expose recovery" }).success).toBe(false);
});
