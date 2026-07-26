import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createZellijRecoveryStore,
  zellijSessionStatePath,
} from "../../packages/terminal-runtime/src/recovery-state.js";

const FIRST = "0123456789abcdef0123456789abcdef";
const SECOND = "11111111111111111111111111111111";
const THIRD = "22222222222222222222222222222222";
const roots: string[] = [];

async function tempRoot() {
  const root = await mkdtemp(join(tmpdir(), "matrix-zellij-recovery-"));
  roots.push(root);
  return root;
}

async function writeState(
  cacheRoot: string,
  runtimeId: string,
  layout = "layout {\n  pane\n}\n",
) {
  const directory = zellijSessionStatePath(cacheRoot, runtimeId);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(join(directory, "session-layout.kdl"), layout, {
    mode: 0o600,
  });
  await writeFile(join(directory, "initial_contents_1"), "saved output\n", {
    mode: 0o600,
  });
  return directory;
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("Zellij recovery state", () => {
  it("maps exact v0.44.3 contract state and classifies missing, corrupt, and incompatible sets", async () => {
    const cacheRoot = await tempRoot();
    await writeState(cacheRoot, FIRST);
    await writeState(cacheRoot, SECOND, "layout {\n  pane {\n");
    const incompatible = join(
      cacheRoot,
      "zellij",
      "contract_version_2",
      "session_info",
      `matrix-t-${THIRD}`,
    );
    await mkdir(incompatible, { recursive: true, mode: 0o700 });
    await writeFile(join(incompatible, "session-layout.kdl"), "layout {}\n");
    const store = createZellijRecoveryStore({ cacheRoot });

    await expect(store.inspect(FIRST)).resolves.toMatchObject({
      state: "valid",
      files: 2,
    });
    await expect(store.inspect(SECOND)).resolves.toMatchObject({
      state: "corrupt",
    });
    await expect(store.inspect(THIRD)).resolves.toMatchObject({
      state: "incompatible",
    });
    await expect(
      store.inspect("33333333333333333333333333333333"),
    ).resolves.toEqual({
      state: "missing",
      bytes: 0,
      files: 0,
      updatedAtMs: null,
    });
  });

  it("removes only the exact runtime state without following attacker symlinks", async () => {
    const cacheRoot = await tempRoot();
    const directory = await writeState(cacheRoot, FIRST);
    const protectedFile = join(cacheRoot, "protected");
    await writeFile(protectedFile, "keep");
    await symlink(protectedFile, join(directory, "untrusted-link"));
    await writeState(cacheRoot, SECOND);
    const store = createZellijRecoveryStore({ cacheRoot });

    await store.remove(FIRST);

    await expect(readFile(protectedFile, "utf8")).resolves.toBe("keep");
    await expect(lstat(join(directory, "session-layout.kdl"))).rejects
      .toMatchObject({ code: "ENOENT" });
    await expect(store.inspect(SECOND)).resolves.toMatchObject({
      state: "valid",
    });
  });

  it("prunes oldest inactive state for count, age, and bytes but never protected live state", async () => {
    const cacheRoot = await tempRoot();
    const first = await writeState(cacheRoot, FIRST);
    const second = await writeState(cacheRoot, SECOND);
    const third = await writeState(cacheRoot, THIRD);
    await utimes(first, 1, 1);
    await utimes(second, 2, 2);
    await utimes(third, 3, 3);
    const store = createZellijRecoveryStore({ cacheRoot });

    const result = await store.prune({
      protectedRuntimeIds: new Set([FIRST]),
      nowMs: 10_000,
      retentionMs: 5_000,
      maxInactiveSets: 1,
      aggregateTargetBytes: 1,
      perRuntimeTargetBytes: 1,
    });

    expect(result.removedRuntimeIds).toEqual([SECOND, THIRD]);
    await expect(store.inspect(FIRST)).resolves.toMatchObject({
      state: "valid",
    });
    await expect(store.inspect(SECOND)).resolves.toMatchObject({
      state: "missing",
    });
  });
});
