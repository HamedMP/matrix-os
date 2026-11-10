import { expect, it } from "vitest";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  access,
  utimes,
  lstat,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import {
  prepareIncoming,
  publishIncoming,
} from "../../scripts/ai-usage/incoming";
import { prepareBackupVersions } from "../../scripts/ai-usage/backup-versions";
it("keeps independent uploads out of verified originals until publication and preserves replaced history", async () => {
  const root = await mkdtemp(join(tmpdir(), "usage-incoming-"));
  const relative = "mac/.codex/sessions/one.jsonl",
    current = join(root, relative);
  try {
    await mkdir(join(current, ".."), { recursive: true });
    await writeFile(current, "original history\n");
    const first = `auto-${randomUUID()}`,
      second = `auto-${randomUUID()}`;
    for (const [id, value] of [
      [first, "first replacement\n"],
      [second, "second replacement is longer\n"],
    ]) {
      await prepareIncoming(root, id);
      const path = join(root, "incoming", id, relative);
      await mkdir(join(path, ".."), { recursive: true });
      await writeFile(path, value);
    }
    expect(await readFile(current, "utf8")).toBe("original history\n");
    const published = await publishIncoming(root, first);
    expect(await readFile(current, "utf8")).toBe("first replacement\n");
    const versions = await prepareBackupVersions(root);
    expect(await readFile(versions.archives[0], "utf8")).toBe(
      "original history\n",
    );
    expect(
      await readFile(join(root, "incoming", second, relative), "utf8"),
    ).toBe("second replacement is longer\n");
    await versions.finish();
    await published.finish();
    await expect(access(join(root, "incoming", first))).rejects.toThrow();
    const next = await publishIncoming(root, second);
    expect(await readFile(current, "utf8")).toBe(
      "second replacement is longer\n",
    );
    await next.finish();
    const stale = `auto-${randomUUID()}`;
    await prepareIncoming(root, stale);
    await utimes(join(root, "incoming", stale), new Date(0), new Date(0));
    await prepareIncoming(root, `auto-${randomUUID()}`);
    await expect(access(join(root, "incoming", stale))).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true });
  }
});
it.each(["stat", "remove"])(
  "tolerates an incoming folder disappearing during %s",
  async (race) => {
    const root = await mkdtemp(join(tmpdir(), "usage-sweep-"));
    try {
      const old = `auto-${randomUUID()}`,
        next = `auto-${randomUUID()}`;
      await prepareIncoming(root, old);
      await utimes(join(root, "incoming", old), new Date(0), new Date(0));
      let injected = false;
      await prepareIncoming(root, next, {
        stat: async (path) => {
          if (race === "stat") {
            await rm(path, { recursive: true });
            injected = true;
          }
          return lstat(path);
        },
        remove: async (path) => {
          if (race === "remove") {
            await rm(path, { recursive: true });
            injected = true;
          }
          await rm(path, { recursive: true });
        },
      });
      expect(injected).toBe(true);
      await access(join(root, "incoming", next));
    } finally {
      await rm(root, { recursive: true });
    }
  },
);
it("publishes a rewritten file even when its size and timestamp are unchanged, keeping the old bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "usage-incoming-"));
  const relative = "mac/.codex/sessions/day/one.jsonl",
    current = join(root, relative),
    when = new Date("2026-11-01T10:00:00Z");
  try {
    await mkdir(join(current, ".."), { recursive: true });
    await writeFile(current, "history AAAA\n");
    await utimes(current, when, when);
    const id = `auto-${randomUUID()}`;
    await prepareIncoming(root, id);
    const staged = join(root, "incoming", id, relative);
    await mkdir(join(staged, ".."), { recursive: true });
    await writeFile(staged, "history BBBB\n");
    await utimes(staged, when, when);
    const published = await publishIncoming(root, id);
    expect(await readFile(current, "utf8")).toBe("history BBBB\n");
    expect((await lstat(current)).mode & 0o777).toBe(0o600);
    const versions = await prepareBackupVersions(root);
    expect(await readFile(versions.archives[0], "utf8")).toBe("history AAAA\n");
    await versions.finish();
    await published.finish();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
