import { describe, expect, it } from "vitest";
import {
  createWatcherIgnored,
  createWatcherPaths,
} from "../../packages/gateway/src/watcher.js";

describe("gateway home watcher", () => {
  it("ignores large development and cache directories by default", () => {
    const ignored = createWatcherIgnored();

    expect(ignored("/home/user/projects/repo/file.ts")).toBe(true);
    expect(ignored("/home/user/matrix-os/something")).toBe(true);
    expect(ignored("/home/user/node_modules/foo")).toBe(true);
    expect(ignored("/home/user/.git/HEAD")).toBe(true);
    expect(ignored("/home/user/.claude/settings")).toBe(true);
    expect(ignored("/home/user/.codex/config")).toBe(true);
    expect(ignored("/home/user/.hermes/data")).toBe(true);
    expect(ignored("/home/user/.local/share")).toBe(true);
    expect(ignored("/home/user/.npm/cache")).toBe(true);
    expect(ignored("/home/user/system/matrix.db")).toBe(true);
    expect(ignored("/home/user/system/matrix.db-wal")).toBe(true);
  });

  it("allows normal home paths", () => {
    const ignored = createWatcherIgnored();

    expect(ignored("/home/user/apps/todo/index.html")).toBe(false);
    expect(ignored("/home/user/system/config.json")).toBe(false);
    expect(ignored("/home/user/agents/custom/builder.md")).toBe(false);
  });

  it("can opt back into watching projects without watching caches", () => {
    const ignored = createWatcherIgnored({ watchProjects: true });

    expect(ignored("/home/user/projects/repo/file.ts")).toBe(false);
    expect(ignored("/home/user/matrix-os/something")).toBe(false);

    expect(ignored("/home/user/node_modules/foo")).toBe(true);
    expect(ignored("/home/user/.git/HEAD")).toBe(true);
    expect(ignored("/home/user/.claude/settings")).toBe(true);
    expect(ignored("/home/user/.codex/config")).toBe(true);
  });

  it("matches directory names as path segments not substrings", () => {
    const ignored = createWatcherIgnored();

    expect(ignored("/home/user/apps/node_modules_info.txt")).toBe(false);
    expect(ignored("/home/user/apps/my-projects-list.md")).toBe(false);
  });

  it("only treats matrix database names as ignored file names", () => {
    const ignored = createWatcherIgnored({ watchProjects: true });

    expect(ignored("/home/user/system/matrix.db")).toBe(true);
    expect(ignored("/home/user/system/matrix.db-wal")).toBe(true);
    expect(ignored("/home/user/apps/matrix.db-backups/config.json")).toBe(false);
  });

  it("watches bounded Matrix-owned roots instead of the whole home", () => {
    expect(createWatcherPaths("/home/matrix/home")).toEqual(expect.arrayContaining([
      "/home/matrix/home/apps",
      "/home/matrix/home/data",
      "/home/matrix/home/system",
      "/home/matrix/home/.matrix-version",
    ]));
    expect(createWatcherPaths("/home/matrix/home")).not.toContain("/home/matrix/home");
    expect(createWatcherPaths("/home/matrix/home")).not.toContain("/home/matrix/home/projects");
    expect(createWatcherPaths("/home/matrix/home")).not.toContain("/home/matrix/home/matrix-os");
  });
});
