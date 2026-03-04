import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const mockSend = vi.fn();

vi.mock("@aws-sdk/client-s3", () => {
  class MockS3Client {
    send = mockSend;
    destroy = vi.fn();
  }
  return {
    S3Client: MockS3Client,
    PutObjectCommand: class { constructor(params: Record<string, unknown>) { Object.assign(this, params); (this as Record<string, unknown>)._type = "PutObject"; } },
    GetObjectCommand: class { constructor(params: Record<string, unknown>) { Object.assign(this, params); (this as Record<string, unknown>)._type = "GetObject"; } },
    ListObjectsV2Command: class { constructor(params: Record<string, unknown>) { Object.assign(this, params); (this as Record<string, unknown>)._type = "ListObjectsV2"; } },
    DeleteObjectCommand: class { constructor(params: Record<string, unknown>) { Object.assign(this, params); (this as Record<string, unknown>)._type = "DeleteObject"; } },
    ListObjectVersionsCommand: class { constructor(params: Record<string, unknown>) { Object.assign(this, params); (this as Record<string, unknown>)._type = "ListObjectVersions"; } },
    HeadObjectCommand: class { constructor(params: Record<string, unknown>) { Object.assign(this, params); (this as Record<string, unknown>)._type = "HeadObject"; } },
  };
});

import {
  createS3SyncDaemon,
  parseSyncignore,
  type S3SyncDaemon,
  type S3SyncConfig,
} from "../../packages/gateway/src/s3-sync.js";

function tmpHome(): string {
  const dir = resolve(mkdtempSync(join(tmpdir(), "s3-sync-")));
  mkdirSync(join(dir, "system"), { recursive: true });
  mkdirSync(join(dir, "apps"), { recursive: true });
  mkdirSync(join(dir, "data"), { recursive: true });
  writeFileSync(join(dir, "system", "state.md"), "hello");
  return dir;
}

function defaultConfig(homePath: string): S3SyncConfig {
  return {
    homePath,
    bucket: "test-bucket",
    prefix: "test-user",
    region: "us-east-1",
    accessKeyId: "AKIATEST",
    secretAccessKey: "secret",
    debounceMs: 100,
    reconcileIntervalMs: 300_000,
    maxConcurrentUploads: 10,
  };
}

describe("T1500: S3 Sync Daemon", () => {
  let homePath: string;
  let daemon: S3SyncDaemon;

  beforeEach(() => {
    vi.useFakeTimers();
    mockSend.mockReset();
    homePath = tmpHome();
  });

  afterEach(() => {
    daemon?.stop();
    vi.useRealTimers();
    if (homePath) rmSync(homePath, { recursive: true, force: true });
  });

  it("creates S3SyncDaemon with start/stop lifecycle", () => {
    daemon = createS3SyncDaemon(defaultConfig(homePath));
    expect(daemon).toBeDefined();
    expect(typeof daemon.start).toBe("function");
    expect(typeof daemon.stop).toBe("function");
    expect(typeof daemon.syncFile).toBe("function");
    expect(typeof daemon.fullSync).toBe("function");
    expect(typeof daemon.restore).toBe("function");
  });

  it("syncFile uploads a file to S3 with correct key", async () => {
    mockSend.mockResolvedValue({});
    daemon = createS3SyncDaemon(defaultConfig(homePath));

    await daemon.syncFile("system/state.md");

    expect(mockSend).toHaveBeenCalledTimes(1);
    const cmd = mockSend.mock.calls[0][0];
    expect(cmd.Bucket).toBe("test-bucket");
    expect(cmd.Key).toBe("test-user/system/state.md");
    expect(cmd.Body).toBeInstanceOf(Buffer);
  });

  it("fullSync uploads all files in home directory", async () => {
    mockSend.mockResolvedValue({});
    writeFileSync(join(homePath, "apps", "todo.html"), "<html></html>");
    daemon = createS3SyncDaemon(defaultConfig(homePath));

    await daemon.fullSync();

    // Should have uploaded system/state.md and apps/todo.html (at minimum)
    expect(mockSend.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("fullSync respects .syncignore patterns", async () => {
    mockSend.mockResolvedValue({});
    writeFileSync(join(homePath, ".syncignore"), "node_modules/\n*.log\ntmp/\n");
    mkdirSync(join(homePath, "node_modules", "some-pkg"), { recursive: true });
    writeFileSync(join(homePath, "node_modules", "some-pkg", "index.js"), "module");
    writeFileSync(join(homePath, "debug.log"), "log line");
    mkdirSync(join(homePath, "tmp"), { recursive: true });
    writeFileSync(join(homePath, "tmp", "temp.txt"), "temp");

    daemon = createS3SyncDaemon(defaultConfig(homePath));
    await daemon.fullSync();

    const uploadedKeys = mockSend.mock.calls.map(
      (call: unknown[]) => (call[0] as { Key: string }).Key,
    );
    expect(uploadedKeys).not.toContain("test-user/node_modules/some-pkg/index.js");
    expect(uploadedKeys).not.toContain("test-user/debug.log");
    expect(uploadedKeys).not.toContain("test-user/tmp/temp.txt");
    expect(uploadedKeys).toContain("test-user/system/state.md");
  });

  it("S3 path uses handle/relative-path structure", async () => {
    mockSend.mockResolvedValue({});
    mkdirSync(join(homePath, "apps", "chess"), { recursive: true });
    writeFileSync(join(homePath, "apps", "chess", "index.html"), "<html>chess</html>");
    daemon = createS3SyncDaemon({
      ...defaultConfig(homePath),
      prefix: "alice",
    });

    await daemon.syncFile("apps/chess/index.html");

    const cmd = mockSend.mock.calls[0][0];
    expect(cmd.Key).toBe("alice/apps/chess/index.html");
  });

  it("queues file uploads with debounce", async () => {
    mockSend.mockResolvedValue({});
    daemon = createS3SyncDaemon({ ...defaultConfig(homePath), debounceMs: 200 });
    daemon.start();

    daemon.onFileChange("system/state.md");
    daemon.onFileChange("system/state.md");
    daemon.onFileChange("system/state.md");

    expect(mockSend).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(300);

    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it("onFileChange skips files matching .syncignore", async () => {
    mockSend.mockResolvedValue({});
    writeFileSync(join(homePath, ".syncignore"), "*.log\n");
    daemon = createS3SyncDaemon({ ...defaultConfig(homePath), debounceMs: 50 });
    daemon.start();

    daemon.onFileChange("debug.log");

    await vi.advanceTimersByTimeAsync(100);

    expect(mockSend).not.toHaveBeenCalled();
  });

  it("retries failed uploads up to 3 times", async () => {
    mockSend
      .mockRejectedValueOnce(new Error("Network error"))
      .mockRejectedValueOnce(new Error("Network error"))
      .mockResolvedValueOnce({});

    daemon = createS3SyncDaemon(defaultConfig(homePath));
    await daemon.syncFile("system/state.md");

    expect(mockSend).toHaveBeenCalledTimes(3);
  });

  it("logs error after 3 failed retry attempts", async () => {
    mockSend.mockRejectedValue(new Error("Persistent failure"));

    daemon = createS3SyncDaemon(defaultConfig(homePath));

    await expect(daemon.syncFile("system/state.md")).rejects.toThrow("Persistent failure");
    expect(mockSend).toHaveBeenCalledTimes(3);
  });
});

describe("T1503: Boot recovery", () => {
  let homePath: string;
  let daemon: S3SyncDaemon;

  beforeEach(() => {
    mockSend.mockReset();
    homePath = tmpHome();
  });

  afterEach(() => {
    daemon?.stop();
    if (homePath) rmSync(homePath, { recursive: true, force: true });
  });

  it("restore pulls files from S3 into empty home directory", async () => {
    const emptyHome = resolve(mkdtempSync(join(tmpdir(), "s3-restore-")));

    mockSend.mockImplementation((cmd: { _type: string; Key?: string }) => {
      if (cmd._type === "ListObjectsV2") {
        return Promise.resolve({
          Contents: [
            { Key: "test-user/system/state.md", Size: 5 },
            { Key: "test-user/apps/todo.html", Size: 20 },
          ],
          IsTruncated: false,
        });
      }
      if (cmd._type === "GetObject") {
        const key = cmd.Key ?? "";
        const content = key.includes("state.md") ? "hello" : "<html>todo</html>";
        return Promise.resolve({
          Body: {
            transformToByteArray: () => Promise.resolve(Buffer.from(content)),
          },
        });
      }
      return Promise.resolve({});
    });

    daemon = createS3SyncDaemon({ ...defaultConfig(emptyHome) });
    await daemon.restore();

    expect(existsSync(join(emptyHome, "system", "state.md"))).toBe(true);
    expect(readFileSync(join(emptyHome, "system", "state.md"), "utf-8")).toBe("hello");
    expect(existsSync(join(emptyHome, "apps", "todo.html"))).toBe(true);
    expect(readFileSync(join(emptyHome, "apps", "todo.html"), "utf-8")).toBe("<html>todo</html>");

    rmSync(emptyHome, { recursive: true, force: true });
  });

  it("restore handles paginated S3 listings", async () => {
    const emptyHome = resolve(mkdtempSync(join(tmpdir(), "s3-restore-page-")));
    let callCount = 0;

    mockSend.mockImplementation((cmd: { _type: string }) => {
      if (cmd._type === "ListObjectsV2") {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve({
            Contents: [{ Key: "test-user/file1.txt", Size: 4 }],
            IsTruncated: true,
            NextContinuationToken: "token123",
          });
        }
        return Promise.resolve({
          Contents: [{ Key: "test-user/file2.txt", Size: 4 }],
          IsTruncated: false,
        });
      }
      if (cmd._type === "GetObject") {
        return Promise.resolve({
          Body: {
            transformToByteArray: () => Promise.resolve(Buffer.from("data")),
          },
        });
      }
      return Promise.resolve({});
    });

    daemon = createS3SyncDaemon({ ...defaultConfig(emptyHome) });
    await daemon.restore();

    expect(existsSync(join(emptyHome, "file1.txt"))).toBe(true);
    expect(existsSync(join(emptyHome, "file2.txt"))).toBe(true);

    rmSync(emptyHome, { recursive: true, force: true });
  });
});

describe("T1504: .syncignore parser", () => {
  it("parses glob patterns", () => {
    const patterns = parseSyncignore("node_modules/\n*.log\n# comment\n\ntmp/\n.cache/\n");
    expect(patterns).toEqual(["node_modules/", "*.log", "tmp/", ".cache/"]);
  });

  it("returns empty array for empty/missing file", () => {
    expect(parseSyncignore("")).toEqual([]);
    expect(parseSyncignore("# only comments\n")).toEqual([]);
  });

  it("matches directory patterns", () => {
    const patterns = parseSyncignore("node_modules/\ntmp/\n");
    expect(patterns).toContain("node_modules/");
    expect(patterns).toContain("tmp/");
  });

  it("matches glob patterns", () => {
    const patterns = parseSyncignore("*.log\n*.sqlite\n");
    expect(patterns).toContain("*.log");
    expect(patterns).toContain("*.sqlite");
  });
});

describe("T1505: S3 versioning API", () => {
  let homePath: string;
  let daemon: S3SyncDaemon;

  beforeEach(() => {
    mockSend.mockReset();
    homePath = tmpHome();
  });

  afterEach(() => {
    daemon?.stop();
    if (homePath) rmSync(homePath, { recursive: true, force: true });
  });

  it("listVersions returns S3 version history for a file", async () => {
    mockSend.mockResolvedValue({
      Versions: [
        {
          VersionId: "v2",
          LastModified: new Date("2026-03-01T12:00:00Z"),
          Size: 100,
          IsLatest: true,
        },
        {
          VersionId: "v1",
          LastModified: new Date("2026-02-28T12:00:00Z"),
          Size: 80,
          IsLatest: false,
        },
      ],
    });

    daemon = createS3SyncDaemon(defaultConfig(homePath));
    const versions = await daemon.listVersions("system/state.md");

    expect(versions).toHaveLength(2);
    expect(versions[0].versionId).toBe("v2");
    expect(versions[0].isLatest).toBe(true);
    expect(versions[1].versionId).toBe("v1");
  });

  it("restoreVersion downloads a specific S3 version", async () => {
    mockSend.mockImplementation((cmd: { _type: string }) => {
      if (cmd._type === "GetObject") {
        return Promise.resolve({
          Body: {
            transformToByteArray: () => Promise.resolve(Buffer.from("old content")),
          },
        });
      }
      return Promise.resolve({});
    });

    daemon = createS3SyncDaemon(defaultConfig(homePath));
    await daemon.restoreVersion("system/state.md", "v1");

    const content = readFileSync(join(homePath, "system", "state.md"), "utf-8");
    expect(content).toBe("old content");
  });
});

describe("T1501: Write-through sync", () => {
  let homePath: string;
  let daemon: S3SyncDaemon;

  beforeEach(() => {
    vi.useFakeTimers();
    mockSend.mockReset();
    mockSend.mockResolvedValue({});
    homePath = tmpHome();
  });

  afterEach(() => {
    daemon?.stop();
    vi.useRealTimers();
    if (homePath) rmSync(homePath, { recursive: true, force: true });
  });

  it("respects max concurrent uploads", async () => {
    let activeUploads = 0;
    let maxActive = 0;

    mockSend.mockImplementation(() => {
      activeUploads++;
      maxActive = Math.max(maxActive, activeUploads);
      return new Promise((resolve) => {
        setTimeout(() => {
          activeUploads--;
          resolve({});
        }, 50);
      });
    });

    daemon = createS3SyncDaemon({
      ...defaultConfig(homePath),
      maxConcurrentUploads: 3,
      debounceMs: 10,
    });
    daemon.start();

    for (let i = 0; i < 10; i++) {
      writeFileSync(join(homePath, `file${i}.txt`), `content ${i}`);
      daemon.onFileChange(`file${i}.txt`);
    }

    await vi.advanceTimersByTimeAsync(20);
    await vi.advanceTimersByTimeAsync(500);

    expect(maxActive).toBeLessThanOrEqual(3);
  });
});

describe("T1502: Periodic reconciliation", () => {
  let homePath: string;
  let daemon: S3SyncDaemon;

  beforeEach(() => {
    vi.useFakeTimers();
    mockSend.mockReset();
    homePath = tmpHome();
  });

  afterEach(() => {
    daemon?.stop();
    vi.useRealTimers();
    if (homePath) rmSync(homePath, { recursive: true, force: true });
  });

  it("reconcile detects files missing from S3 and uploads them", async () => {
    mockSend.mockImplementation((cmd: { _type: string }) => {
      if (cmd._type === "ListObjectsV2") {
        return Promise.resolve({ Contents: [], IsTruncated: false });
      }
      return Promise.resolve({});
    });

    writeFileSync(join(homePath, "apps", "app.html"), "<html>app</html>");

    daemon = createS3SyncDaemon(defaultConfig(homePath));
    const stats = await daemon.reconcile();

    expect(stats.filesChecked).toBeGreaterThan(0);
    expect(stats.uploadsNeeded).toBeGreaterThan(0);
  });

  it("reconcile triggers on interval when started", async () => {
    mockSend.mockImplementation((cmd: { _type: string }) => {
      if (cmd._type === "ListObjectsV2") {
        return Promise.resolve({ Contents: [], IsTruncated: false });
      }
      return Promise.resolve({});
    });

    daemon = createS3SyncDaemon({
      ...defaultConfig(homePath),
      reconcileIntervalMs: 1000,
    });
    daemon.start();

    await vi.advanceTimersByTimeAsync(1100);

    const listCalls = mockSend.mock.calls.filter(
      (call: unknown[]) => (call[0] as { _type: string })._type === "ListObjectsV2",
    );
    expect(listCalls.length).toBeGreaterThanOrEqual(1);
  });
});
