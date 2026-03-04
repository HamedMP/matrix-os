import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createAuditLogger, type AuditLogger } from "../../packages/kernel/src/audit.js";

function makeTempHome(): string {
  const dir = resolve(mkdtempSync(join(tmpdir(), "audit-")));
  mkdirSync(join(dir, "system", "logs"), { recursive: true });
  return dir;
}

function readAuditEntries(homePath: string) {
  const auditPath = join(homePath, "system", "logs", "audit.jsonl");
  if (!existsSync(auditPath)) return [];
  return readFileSync(auditPath, "utf-8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

describe("T1370: File audit logger", () => {
  let homePath: string;
  let logger: AuditLogger;

  beforeEach(() => {
    homePath = makeTempHome();
    logger = createAuditLogger(join(homePath, "system", "logs"));
  });

  afterEach(() => {
    rmSync(homePath, { recursive: true, force: true });
  });

  it("initializes without error", () => {
    expect(logger).toBeDefined();
    expect(typeof logger.log).toBe("function");
  });

  it("logs file write operations with path, size, actor", () => {
    logger.log({
      op: "write",
      path: "modules/todo/index.html",
      sizeBytes: 1234,
      actor: "builder",
    });

    const entries = readAuditEntries(homePath);
    expect(entries).toHaveLength(1);
    expect(entries[0].op).toBe("write");
    expect(entries[0].path).toBe("modules/todo/index.html");
    expect(entries[0].sizeBytes).toBe(1234);
    expect(entries[0].actor).toBe("builder");
    expect(entries[0].timestamp).toBeDefined();
  });

  it("logs file delete operations", () => {
    logger.log({
      op: "delete",
      path: "modules/old/index.html",
      actor: "evolver",
    });

    const entries = readAuditEntries(homePath);
    expect(entries).toHaveLength(1);
    expect(entries[0].op).toBe("delete");
  });

  it("logs mkdir operations", () => {
    logger.log({
      op: "mkdir",
      path: "modules/new-app",
      actor: "builder",
    });

    const entries = readAuditEntries(homePath);
    expect(entries).toHaveLength(1);
    expect(entries[0].op).toBe("mkdir");
  });

  it("handles rapid successive writes", () => {
    for (let i = 0; i < 100; i++) {
      logger.log({
        op: "write",
        path: `file-${i}.txt`,
        sizeBytes: i * 10,
        actor: "builder",
      });
    }

    const entries = readAuditEntries(homePath);
    expect(entries).toHaveLength(100);
  });

  it("JSONL format is parseable", () => {
    logger.log({ op: "write", path: "a.txt", sizeBytes: 10, actor: "builder" });
    logger.log({ op: "delete", path: "b.txt", actor: "healer" });

    const auditPath = join(homePath, "system", "logs", "audit.jsonl");
    const content = readFileSync(auditPath, "utf-8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  it("creates log directory if it does not exist", () => {
    const freshDir = resolve(mkdtempSync(join(tmpdir(), "audit-fresh-")));
    const logDir = join(freshDir, "system", "logs");
    const freshLogger = createAuditLogger(logDir);

    freshLogger.log({ op: "write", path: "test.txt", sizeBytes: 5, actor: "test" });

    const auditPath = join(logDir, "audit.jsonl");
    expect(existsSync(auditPath)).toBe(true);

    rmSync(freshDir, { recursive: true, force: true });
  });
});

describe("T1372: Log rotation", () => {
  let homePath: string;

  beforeEach(() => {
    homePath = makeTempHome();
  });

  afterEach(() => {
    rmSync(homePath, { recursive: true, force: true });
  });

  it("rotateActivityLog renames activity.log to activity-{date}.log", async () => {
    const { rotateActivityLog } = await import("../../packages/kernel/src/audit.js");
    const activityPath = join(homePath, "system", "activity.log");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(activityPath, "old log content\n");

    const rotatedPath = rotateActivityLog(join(homePath, "system"));
    expect(rotatedPath).toBeDefined();
    expect(existsSync(activityPath)).toBe(false);
    expect(existsSync(rotatedPath!)).toBe(true);
    expect(readFileSync(rotatedPath!, "utf-8")).toBe("old log content\n");
  });

  it("rotateActivityLog returns null when no activity.log exists", async () => {
    const { rotateActivityLog } = await import("../../packages/kernel/src/audit.js");
    const result = rotateActivityLog(join(homePath, "system"));
    expect(result).toBeNull();
  });

  it("cleanOldLogs deletes files older than retention days", async () => {
    const { cleanOldLogs } = await import("../../packages/kernel/src/audit.js");
    const logsDir = join(homePath, "system", "logs");
    const { writeFileSync, utimesSync } = await import("node:fs");

    const oldDate = new Date();
    oldDate.setDate(oldDate.getDate() - 40);

    const oldFile = join(logsDir, `activity-${oldDate.toISOString().slice(0, 10)}.log`);
    writeFileSync(oldFile, "old");
    utimesSync(oldFile, oldDate, oldDate);

    const recentFile = join(logsDir, "activity-recent.log");
    writeFileSync(recentFile, "recent");

    cleanOldLogs(logsDir, 30);

    expect(existsSync(oldFile)).toBe(false);
    expect(existsSync(recentFile)).toBe(true);
  });
});
