import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { preflightBatchMove } from "../../packages/gateway/src/file-management/preflight.js";

describe("preflightBatchMove", () => {
  let homePath: string;

  beforeEach(() => {
    homePath = join(tmpdir(), `file-batch-preflight-${Date.now()}-${Math.random()}`);
    mkdirSync(join(homePath, "projects", "inbox"), { recursive: true });
    mkdirSync(join(homePath, "projects", "archive"), { recursive: true });
    writeFileSync(join(homePath, "projects", "inbox", "a.md"), "a");
    writeFileSync(join(homePath, "projects", "inbox", "b.md"), "b");
  });

  afterEach(() => {
    rmSync(homePath, { recursive: true, force: true });
  });

  it("preserves normalized source order and reports conflicts in that order", async () => {
    writeFileSync(join(homePath, "projects", "archive", "b.md"), "existing b");
    writeFileSync(join(homePath, "projects", "archive", "a.md"), "existing a");

    await expect(preflightBatchMove({
      homePath,
      sources: ["projects/inbox/b.md", "projects/inbox/a.md"],
      destinationDirectory: "projects/archive",
    })).resolves.toMatchObject({
      sources: ["projects/inbox/b.md", "projects/inbox/a.md"],
      destinationDirectory: "projects/archive",
      conflicts: [
        { source: "projects/inbox/b.md", destination: "projects/archive/b.md" },
        { source: "projects/inbox/a.md", destination: "projects/archive/a.md" },
      ],
      invalid: [],
    });
  });

  it("enforces a shared source parent before inspecting the filesystem", async () => {
    mkdirSync(join(homePath, "projects", "other"), { recursive: true });
    writeFileSync(join(homePath, "projects", "other", "c.md"), "c");

    await expect(preflightBatchMove({
      homePath,
      sources: ["projects/inbox/a.md", "projects/other/c.md"],
      destinationDirectory: "projects/archive",
    })).rejects.toMatchObject({ code: "invalid_destination" });
  });

  it("returns a source-not-found item from fresh filesystem state", async () => {
    await expect(preflightBatchMove({
      homePath,
      sources: ["projects/inbox/missing.md"],
      destinationDirectory: "projects/archive",
    })).resolves.toMatchObject({
      invalid: [{ source: "projects/inbox/missing.md", code: "source_missing" }],
    });
  });

  it("returns protected source items without relying on a prior listing capability", async () => {
    mkdirSync(join(homePath, "system"), { recursive: true });
    writeFileSync(join(homePath, "system", "settings.json"), "{}");

    await expect(preflightBatchMove({
      homePath,
      sources: ["system/settings.json"],
      destinationDirectory: "projects/archive",
    })).resolves.toMatchObject({
      invalid: [{ source: "system/settings.json", code: "protected" }],
    });
  });

  it("rejects the sources' current directory as a destination", async () => {
    await expect(preflightBatchMove({
      homePath,
      sources: ["projects/inbox/a.md"],
      destinationDirectory: "projects/inbox",
    })).resolves.toMatchObject({
      invalid: [{ source: "projects/inbox/a.md", code: "invalid_destination" }],
    });
  });

  it("rejects moving a directory into itself or one of its descendants", async () => {
    mkdirSync(join(homePath, "projects", "inbox", "folder", "nested"), { recursive: true });

    await expect(preflightBatchMove({
      homePath,
      sources: ["projects/inbox/folder"],
      destinationDirectory: "projects/inbox/folder",
    })).resolves.toMatchObject({
      invalid: [{ source: "projects/inbox/folder", code: "invalid_destination" }],
    });
    await expect(preflightBatchMove({
      homePath,
      sources: ["projects/inbox/folder"],
      destinationDirectory: "projects/inbox/folder/nested",
    })).resolves.toMatchObject({
      invalid: [{ source: "projects/inbox/folder", code: "invalid_destination" }],
    });
  });
});
