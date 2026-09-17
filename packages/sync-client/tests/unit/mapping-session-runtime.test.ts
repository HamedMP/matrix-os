import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { SyncMapping } from "@matrix-os/contracts/sync";

const mocks = vi.hoisted(() => {
  const watchers: Array<{ options: { onEvent: (event: unknown) => Promise<void> }; start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> }> = [];
  return {
    watchers,
    commitFiles: vi.fn(),
    requestPresignedUrls: vi.fn(),
    uploadFile: vi.fn(),
  };
});

vi.mock("../../src/daemon/watcher.js", () => ({
  FileWatcher: class {
    start = vi.fn();
    stop = vi.fn().mockResolvedValue(undefined);
    constructor(public options: { onEvent: (event: unknown) => Promise<void> }) {
      mocks.watchers.push(this);
    }
  },
}));

vi.mock("../../src/daemon/r2-client.js", () => {
  class AuthRejectedError extends Error {}
  class VersionConflictError extends Error {
    constructor(public currentVersion: number) { super("version conflict"); }
  }
  return {
    AuthRejectedError,
    VersionConflictError,
    requestPresignedUrls: mocks.requestPresignedUrls,
    uploadFile: mocks.uploadFile,
    downloadFile: vi.fn(),
    commitFiles: mocks.commitFiles,
  };
});

import { openMappingSessions, startMappingSessions } from "../../src/daemon/mapping-supervisor.js";

function mapping(input: Pick<SyncMapping, "id" | "localRoot" | "remotePrefix" | "label"> & Partial<SyncMapping>): SyncMapping {
  return {
    direction: "two_way",
    enabled: true,
    propagateDeletes: false,
    excludes: [],
    ...input,
  };
}

describe("multi-mapping runtime wiring", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "mapping-runtime-"));
    mocks.watchers.length = 0;
    mocks.commitFiles.mockReset();
    mocks.requestPresignedUrls.mockReset();
    mocks.uploadFile.mockReset();
    mocks.requestPresignedUrls.mockImplementation(async (_client, requests: Array<{ path: string }>) => (
      requests.map((request) => ({
        path: request.path,
        action: "put",
        url: `https://upload.invalid/${request.path}`,
        stagingId: `stage-${request.path}`,
      }))
    ));
    let version = 10;
    mocks.commitFiles.mockImplementation(async () => ({ manifestVersion: ++version }));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("runs full-home plus two custom mappings without redirecting queued uploads", async () => {
    const roots = [join(root, "home"), join(root, "one"), join(root, "two")];
    await Promise.all(roots.map((path) => mkdir(path, { recursive: true })));
    await Promise.all(roots.map((path, index) => writeFile(join(path, "note.md"), String(index))));
    const mappings = [
      mapping({
        id: "11111111-1111-4111-8111-111111111111",
        label: "Matrix Home",
        localRoot: roots[0]!,
        remotePrefix: "",
        excludes: ["projects/one/", "projects/two/"],
      }),
      mapping({
        id: "21111111-1111-4111-8111-111111111111",
        label: "One",
        localRoot: roots[1]!,
        remotePrefix: "projects/one",
      }),
      mapping({
        id: "31111111-1111-4111-8111-111111111111",
        label: "Two",
        localRoot: roots[2]!,
        remotePrefix: "projects/two",
      }),
    ];
    const sessions = await openMappingSessions({
      configDir: join(root, "config"),
      config: {
        schemaVersion: 2,
        revision: 1,
        profile: "cloud",
        ownerId: "user_test",
        runtimeSlot: "primary",
        deviceId: "device-test",
        enabled: true,
        mappings,
      },
      gatewayClient: { gatewayUrl: "https://gateway.invalid", token: "token" },
      revision: { value: 10 },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      enqueue: async (fn) => fn(),
      onAuthRejected: vi.fn(),
    });
    await startMappingSessions(sessions, {});

    await Promise.all(mocks.watchers.map((watcher, index) => watcher.options.onEvent({
      type: "change",
      path: "note.md",
      hash: `sha256:${String(index + 1).repeat(64)}`,
      size: 1,
      mtime: 1,
    })));

    expect(mocks.commitFiles.mock.calls.map((call) => call[1][0].path).sort()).toEqual([
      "note.md",
      "projects/one/note.md",
      "projects/two/note.md",
    ]);
    expect(mocks.uploadFile.mock.calls.map((call) => call[1]).sort()).toEqual([
      join(roots[0]!, "note.md"),
      join(roots[1]!, "note.md"),
      join(roots[2]!, "note.md"),
    ].sort());
  });
});
