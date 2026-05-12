import { describe, expect, it } from "vitest";
import {
  createWatcherIgnoredGlobs,
  createWatcherPaths,
} from "../../packages/gateway/src/watcher.js";

describe("gateway home watcher", () => {
  it("ignores large development and cache directories by default", () => {
    expect(createWatcherIgnoredGlobs()).toEqual(expect.arrayContaining([
      "**/projects/**",
      "**/matrix-os/**",
      "**/.claude/**",
      "**/.codex/**",
      "**/.hermes/**",
      "**/.local/**",
      "**/.npm/**",
    ]));
  });

  it("can opt back into watching projects without watching caches", () => {
    const ignored = createWatcherIgnoredGlobs({ watchProjects: true });

    expect(ignored).not.toContain("**/projects/**");
    expect(ignored).not.toContain("**/matrix-os/**");
    expect(ignored).toEqual(expect.arrayContaining([
      "**/node_modules/**",
      "**/.git/**",
      "**/.claude/**",
      "**/.codex/**",
    ]));
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
