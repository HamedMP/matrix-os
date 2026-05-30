import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  ClientErrorReportSchema,
  clientErrorLogPath,
  writeClientErrorReport,
} from "../../packages/gateway/src/client-error-log.js";

async function tmpHome(): Promise<string> {
  return resolve(await mkdtemp(join(tmpdir(), "client-error-log-")));
}

describe("client error log", () => {
  const homes: string[] = [];

  afterEach(async () => {
    await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
  });

  it("accepts bounded shell error boundary reports", () => {
    const report = ClientErrorReportSchema.parse({
      errorId: "mx-339sbf-bdf7b985",
      source: "shell-error-boundary",
      name: "TypeError",
      message: "Cannot read properties of undefined",
      stack: "TypeError: Cannot read properties of undefined",
      path: "/vm/hamed-billing-staging",
      userAgent: "Mozilla/5.0",
      buildSha: "ea89261d59362753accd577f9d56a0c85e611cc2",
    });

    expect(report.errorId).toBe("mx-339sbf-bdf7b985");
  });

  it("rejects malformed error IDs and unknown fields", () => {
    expect(ClientErrorReportSchema.safeParse({ errorId: "../nope" }).success).toBe(false);
    expect(ClientErrorReportSchema.safeParse({
      errorId: "mx-339sbf-bdf7b985",
      rawSecret: "do-not-store",
    }).success).toBe(false);
  });

  it("writes client error reports to the owner-local logs directory", async () => {
    const homePath = await tmpHome();
    homes.push(homePath);

    await writeClientErrorReport(homePath, {
      errorId: "mx-339sbf-bdf7b985",
      source: "shell-error-boundary",
      name: "TypeError",
      message: "Cannot read properties of undefined",
      path: "/vm/hamed-billing-staging",
    });

    const line = await readFile(clientErrorLogPath(homePath), "utf-8");
    const entry = JSON.parse(line);
    expect(entry.errorId).toBe("mx-339sbf-bdf7b985");
    expect(entry.source).toBe("shell-error-boundary");
    expect(entry.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}/);
  });
});
