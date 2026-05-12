import { mkdir, readFile, symlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import {
  createBrowserDownloadPaths,
  deleteBrowserDownloadArtifacts,
  installBrowserDownloadHooks,
  publishBrowserDownload,
  resolveWithinHome,
  sanitizeBrowserFilename,
  sweepBrowserTempFiles,
} from "../../packages/gateway/src/browser/profile-store.js";

describe("Browser download profile store", () => {
  it("sanitizes filenames and resolves paths inside the owner home", () => {
    expect(sanitizeBrowserFilename("../../secret:name?.txt")).toBe("secret_name_.txt");
    expect(() => resolveWithinHome("/home/owner", "..", "other")).toThrow("invalid_path");
  });

  it("stages downloads before atomic publish to the owner files surface", async () => {
    const home = await mkdtemp(join(tmpdir(), "matrix-browser-downloads-"));
    const paths = await createBrowserDownloadPaths(home, "../report.txt");
    expect(paths.stagingPath).toContain("/system/browser/downloads/staging/");
    expect(paths.finalPath).toBe(join(home, "files", "downloads", "report.txt"));

    await writeFile(paths.stagingPath, "ok");
    await publishBrowserDownload(paths.stagingPath, paths.finalPath);
    await expect(readFile(paths.finalPath, "utf8")).resolves.toBe("ok");
  });

  it("chooses no-clobber completed download paths", async () => {
    const home = await mkdtemp(join(tmpdir(), "matrix-browser-downloads-"));
    const first = await createBrowserDownloadPaths(home, "report.txt");
    await writeFile(first.stagingPath, "first");
    await publishBrowserDownload(first.stagingPath, first.finalPath);

    const second = await createBrowserDownloadPaths(home, "report.txt");
    expect(second.finalPath).toBe(join(home, "files", "downloads", "report (1).txt"));
    await writeFile(second.stagingPath, "second");
    await publishBrowserDownload(second.stagingPath, second.finalPath);

    await expect(readFile(first.finalPath, "utf8")).resolves.toBe("first");
    await expect(readFile(second.finalPath, "utf8")).resolves.toBe("second");
  });

  it("deletes staged and completed artifacts without leaving owner home", async () => {
    const home = await mkdtemp(join(tmpdir(), "matrix-browser-delete-"));
    const paths = await createBrowserDownloadPaths(home, "report.txt");
    await writeFile(paths.stagingPath, "partial");
    await writeFile(paths.finalPath, "done");

    await deleteBrowserDownloadArtifacts(home, paths);

    await expect(readFile(paths.stagingPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(paths.finalPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(deleteBrowserDownloadArtifacts(home, {
      stagingPath: "/tmp/not-owned.part",
      finalPath: null,
    })).rejects.toThrow("invalid_path");
  });

  it("cleans stale partials without following symlinks", async () => {
    const home = await mkdtemp(join(tmpdir(), "matrix-browser-sweep-"));
    const staging = join(home, "staging");
    await mkdir(staging, { recursive: true });
    const stale = join(staging, "old.part");
    const fresh = join(staging, "fresh.part");
    const linked = join(staging, "link.part");
    await writeFile(stale, "old");
    await writeFile(fresh, "fresh");
    await symlink(fresh, linked);
    await utimes(stale, new Date(1_000), new Date(1_000));

    expect(await sweepBrowserTempFiles(staging, { maxAgeMs: 10_000, now: 20_000 })).toBe(1);
  });

  it("wires Chromium download events through staged publish callbacks", async () => {
    const home = await mkdtemp(join(tmpdir(), "matrix-browser-hook-"));
    let handler: ((download: {
      suggestedFilename(): string;
      saveAs(path: string): Promise<void>;
      failure(): Promise<string | null>;
    }) => void) | undefined;
    const events: string[] = [];

    installBrowserDownloadHooks({
      on(_event, nextHandler) {
        handler = nextHandler;
      },
    }, {
      homePath: home,
      callbacks: {
        async create(input) {
          events.push(`create:${input.filename}`);
          return { id: "download_1" };
        },
        async complete(input) {
          events.push(`complete:${input.id}:${input.completedPath.endsWith("report.pdf")}`);
        },
        async fail(input) {
          events.push(`fail:${input.id}`);
        },
      },
    });

    handler?.({
      suggestedFilename: () => "../report.pdf",
      async saveAs(path) {
        events.push(`save:${path.endsWith(".part")}`);
        await writeFile(path, "done");
      },
      async failure() {
        return null;
      },
    });
    await vi.waitFor(() => expect(events).toHaveLength(3));

    expect(events).toEqual([
      "create:report.pdf",
      "save:true",
      "complete:download_1:true",
    ]);
    await expect(readFile(join(home, "files/downloads/report.pdf"), "utf8")).resolves.toBe("done");
  });
});
