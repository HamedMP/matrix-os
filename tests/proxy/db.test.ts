import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

describe("proxy db.ts", () => {
  let tmpDir: string;
  let dbPath: string;
  let origEnv: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-db-test-"));
    dbPath = path.join(tmpDir, "nested", "dir", "proxy.db");
    origEnv = process.env.PROXY_DB_PATH;
    process.env.PROXY_DB_PATH = dbPath;
    vi.resetModules();
  });

  afterEach(() => {
    if (origEnv === undefined) delete process.env.PROXY_DB_PATH;
    else process.env.PROXY_DB_PATH = origEnv;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates the parent directory if it does not exist", async () => {
    const { getDb } = await import("../../packages/proxy/src/db.js");
    expect(() => getDb()).not.toThrow();
    expect(fs.existsSync(dbPath)).toBe(true);
  });
});
