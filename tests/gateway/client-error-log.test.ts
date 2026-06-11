import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  ClientErrorReportSchema,
  clientErrorLogPath,
  forwardClientErrorToPostHog,
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

describe("client error PostHog forwarding", () => {
  const report = ClientErrorReportSchema.parse({
    errorId: "mx-339sbf-bdf7b985",
    source: "shell-error-boundary",
    name: "TypeError",
    message: "Cannot read properties of undefined",
    stack: "TypeError: Cannot read properties of undefined\n    at App (app.js:1:1)",
    digest: "digest-123",
    path: "/vm/hamed-billing-staging",
    userAgent: "Mozilla/5.0",
    buildSha: "ea89261d59362753accd577f9d56a0c85e611cc2",
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("forwards a reconstructed exception with safe properties to the tracker", () => {
    const captureException = vi.fn().mockResolvedValue(true);

    forwardClientErrorToPostHog({ captureException }, "user_123", report);

    expect(captureException).toHaveBeenCalledTimes(1);
    const [error, options] = captureException.mock.calls[0] as [Error, {
      distinctId?: string;
      properties?: Record<string, unknown>;
    }];
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("TypeError");
    expect(error.message).toBe("Cannot read properties of undefined");
    expect(error.stack).toContain("at App (app.js:1:1)");
    expect(options.distinctId).toBe("user_123");
    expect(options.properties).toMatchObject({
      source: "shell-client-error",
      report_source: "shell-error-boundary",
      digest: "digest-123",
      errorId: "mx-339sbf-bdf7b985",
      path: "/vm/hamed-billing-staging",
      build_sha: "ea89261d59362753accd577f9d56a0c85e611cc2",
      user_agent: "Mozilla/5.0",
    });
  });

  it("falls back to a generic error shape when name and message are absent", () => {
    const captureException = vi.fn().mockResolvedValue(true);

    forwardClientErrorToPostHog({ captureException }, "user_123", {
      errorId: "mx-anon-1",
    });

    const [error] = captureException.mock.calls[0] as [Error];
    expect(error.name).toBe("ClientError");
    expect(error.message.length).toBeGreaterThan(0);
  });

  it("never throws when capture rejects and logs only the error name", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const captureException = vi
      .fn()
      .mockRejectedValue(new Error("secret-flush-detail /home/matrix/private"));

    expect(() => forwardClientErrorToPostHog({ captureException }, "user_123", report)).not.toThrow();
    await new Promise((resolveSettle) => setImmediate(resolveSettle));

    expect(warn).toHaveBeenCalled();
    const logged = warn.mock.calls.map((call) => call.join(" ")).join(" ");
    expect(logged).toContain("Error");
    expect(logged).not.toContain("secret-flush-detail");
    expect(logged).not.toContain("/home/matrix/private");
  });

  it("isolates trackers that throw synchronously", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const captureException = vi.fn(() => {
      throw new TypeError("sync-capture-detail");
    });

    const tracker = { captureException } as unknown as Parameters<typeof forwardClientErrorToPostHog>[0];
    expect(() => forwardClientErrorToPostHog(tracker, "user_123", report)).not.toThrow();

    const logged = warn.mock.calls.map((call) => call.join(" ")).join(" ");
    expect(logged).toContain("TypeError");
    expect(logged).not.toContain("sync-capture-detail");
  });
});
