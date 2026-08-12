import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { link, unlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FileBatchTrashService } from "../../packages/gateway/src/file-management/batch-service.js";
import type { NativeFileCapabilityResult } from "../../packages/gateway/src/file-management/native-file-capability.js";
import type { NoReplaceFileMoveCapability } from "../../packages/gateway/src/file-ops.js";
import {
  TrashManifestQueue,
  TrashManifestQueueCapacityError,
  TrashManifestQueueClosedError,
} from "../../packages/gateway/src/trash.js";

describe("FileBatchTrashService partial queue settlement", () => {
  let homePath: string;

  beforeEach(() => {
    homePath = join(tmpdir(), `file-batch-trash-partial-${process.pid}-${Date.now()}-${Math.random()}`);
    mkdirSync(join(homePath, "projects", "inbox"), { recursive: true });
  });

  afterEach(() => {
    rmSync(homePath, { recursive: true, force: true });
  });

  it.each(["capacity", "closed"] as const)(
    "caches a partial result when the queue becomes %s after a committed item",
    async (scenario) => {
      const manifestQueue = new FailSecondTrashManifestQueue(scenario);
      const service = new FileBatchTrashService({
        manifestQueue,
        moveCapability: new FileMoveCapability(),
      });
      writeFileSync(join(homePath, "projects", "inbox", "committed.md"), "committed");
      writeFileSync(join(homePath, "projects", "inbox", "retained.md"), "retained");
      const request = {
        ownerId: "owner-a",
        homePath,
        requestId: "b9d9d1d8-8e5d-45d0-8d17-000000000001",
        sources: ["projects/inbox/committed.md", "projects/inbox/retained.md"],
      };

      const first = await service.trash(request);
      const replay = await service.trash(request);

      expect(first.results).toEqual([
        { source: "projects/inbox/committed.md", code: "trashed" },
        { source: "projects/inbox/retained.md", code: "failed" },
      ]);
      expect(replay).toEqual(first);
      expect(manifestQueue.runCalls).toBe(2);
      expect(existsSync(join(homePath, "projects", "inbox", "committed.md"))).toBe(false);
      expect(readFileSync(join(homePath, "projects", "inbox", "retained.md"), "utf8"))
        .toBe("retained");
      await service.close();
      await manifestQueue.close();
    },
  );
});

class FailSecondTrashManifestQueue extends TrashManifestQueue {
  runCalls = 0;

  constructor(private readonly scenario: "capacity" | "closed") {
    super();
  }

  override run<T>(homePath: string, operation: () => Promise<T>): Promise<T> {
    this.runCalls += 1;
    if (this.runCalls === 2) {
      return Promise.reject(this.scenario === "capacity"
        ? new TrashManifestQueueCapacityError()
        : new TrashManifestQueueClosedError());
    }
    return super.run(homePath, operation);
  }
}

class FileMoveCapability implements NoReplaceFileMoveCapability {
  async move(
    homePath: string,
    sourcePath: string,
    targetPath: string,
    createParents: boolean,
  ): Promise<NativeFileCapabilityResult> {
    if (createParents) return { ok: false, code: "invalid_path" };
    await link(join(homePath, sourcePath), join(homePath, targetPath));
    await unlink(join(homePath, sourcePath));
    return { ok: true, code: "ok" };
  }
}
