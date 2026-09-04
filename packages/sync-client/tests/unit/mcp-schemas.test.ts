import { describe, expect, it } from "vitest";
import {
  DownloadFileInputSchema,
  MatrixPathSchema,
  RunCommandInputSchema,
  SendTerminalInputSchema,
  UploadFileInputSchema,
  decodeUploadContent,
} from "../../src/mcp/schemas.js";
import { toSafeMcpError } from "../../src/mcp/errors.js";

describe("Matrix MCP boundary schemas", () => {
  it("normalizes owner-relative Matrix paths and rejects escape syntax", () => {
    expect(MatrixPathSchema.parse("~/projects/./matrix/README.md")).toBe("projects/matrix/README.md");
    expect(MatrixPathSchema.parse(".")).toBe(".");
    for (const path of ["/etc/passwd", "../secret", "projects/../../secret", "projects\\secret", "bad\0path", "bad\npath"]) {
      expect(MatrixPathSchema.safeParse(path).success, path).toBe(false);
    }
  });

  it("caps command argv, command items, cwd, and timeout", () => {
    expect(RunCommandInputSchema.parse({
      computer: "review-1",
      command: ["git", "status", "--short"],
      cwd: "~/projects/repo",
      timeoutMs: 1_800_000,
    })).toEqual({
      computer: "review-1",
      command: ["git", "status", "--short"],
      cwd: "projects/repo",
      timeoutMs: 1_800_000,
    });
    expect(RunCommandInputSchema.safeParse({ computer: "review-1", command: [] }).success).toBe(false);
    expect(RunCommandInputSchema.safeParse({ computer: "review_1", command: ["pwd"] }).success).toBe(false);
    expect(RunCommandInputSchema.safeParse({ computer: "review-1", command: ["x".repeat(4097)] }).success).toBe(false);
    expect(RunCommandInputSchema.safeParse({ computer: "review-1", command: ["pwd"], timeoutMs: 1_800_001 }).success).toBe(false);
  });

  it("uses a stricter byte cap for terminal input", () => {
    expect(SendTerminalInputSchema.parse({
      computer: "primary",
      terminal: "agent-task",
      data: "bun test\n",
    }).data).toBe("bun test\n");
    expect(SendTerminalInputSchema.safeParse({
      computer: "primary",
      terminal: "agent-task",
      data: "😀".repeat(15_001),
    }).success).toBe(false);
  });

  it("accepts exact base64 uploads and rejects malformed or oversized content", () => {
    const input = UploadFileInputSchema.parse({
      computer: "primary",
      path: "artifacts/pixel.bin",
      encoding: "base64",
      content: Buffer.from([0, 1, 2, 255]).toString("base64"),
    });
    expect(decodeUploadContent(input)).toEqual(Buffer.from([0, 1, 2, 255]));

    expect(UploadFileInputSchema.safeParse({
      computer: "primary",
      path: "artifacts/pixel.bin",
      encoding: "base64",
      content: "not-base64!",
    }).success).toBe(false);
    expect(UploadFileInputSchema.safeParse({
      computer: "primary",
      path: "artifacts/large.bin",
      encoding: "utf8",
      content: "x".repeat(1024 * 1024 + 1),
    }).success).toBe(false);
  });

  it("does not accept a local destination for downloads", () => {
    expect(DownloadFileInputSchema.safeParse({
      computer: "primary",
      path: "artifacts/report.pdf",
      localPath: "/tmp/report.pdf",
    }).success).toBe(false);
  });
});

describe("safe MCP errors", () => {
  it("maps known errors and hides unknown messages", () => {
    expect(toSafeMcpError(Object.assign(new Error("token expired at secret path"), { code: "auth_expired" }))).toEqual({
      code: "auth_required",
      message: "Authenticate with the Matrix CLI and try again.",
      retryable: false,
    });
    expect(toSafeMcpError(new Error("postgres://secret@private-host/db"))).toEqual({
      code: "request_failed",
      message: "Matrix could not complete the request.",
      retryable: true,
    });
  });
});
