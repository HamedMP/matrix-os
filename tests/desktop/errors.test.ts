import { describe, expect, it } from "vitest";
import {
  AppError,
  classifyHttpStatus,
  classifyTransportError,
} from "@desktop/shared/app-error";
import { sanitizeServerMessage, toUserMessage } from "@desktop/renderer/src/lib/errors";

describe("classifyHttpStatus", () => {
  it("maps statuses to categories", () => {
    expect(classifyHttpStatus(401)).toBe("unauthorized");
    expect(classifyHttpStatus(403)).toBe("unauthorized");
    expect(classifyHttpStatus(404)).toBe("notFound");
    expect(classifyHttpStatus(500)).toBe("server");
    expect(classifyHttpStatus(502)).toBe("server");
    expect(classifyHttpStatus(418)).toBe("server");
  });
});

describe("classifyTransportError", () => {
  it("maps timeout aborts to timeout", () => {
    const err = new DOMException("The operation timed out.", "TimeoutError");
    expect(classifyTransportError(err)).toBe("timeout");
  });

  it("maps abort to timeout", () => {
    const err = new DOMException("Aborted", "AbortError");
    expect(classifyTransportError(err)).toBe("timeout");
  });

  it("maps fetch TypeError to offline", () => {
    expect(classifyTransportError(new TypeError("fetch failed"))).toBe("offline");
  });

  it("maps unknown errors to server", () => {
    expect(classifyTransportError(new Error("boom"))).toBe("server");
  });
});

describe("AppError", () => {
  it("carries a category and never exposes cause text in message", () => {
    const err = new AppError("server", { cause: new Error("pg: connection refused at /home/x") });
    expect(err.category).toBe("server");
    expect(err.message).not.toContain("pg");
    expect(err.message).not.toContain("/home/");
  });
});

describe("toUserMessage", () => {
  it("returns generic copy per category", () => {
    expect(toUserMessage(new AppError("unauthorized"))).toMatch(/sign in/i);
    expect(toUserMessage(new AppError("offline"))).toMatch(/connection/i);
    expect(toUserMessage(new AppError("timeout"))).toMatch(/timed out/i);
    expect(toUserMessage(new AppError("notFound"))).toMatch(/not.*found/i);
    expect(toUserMessage(new AppError("misconfigured"))).toMatch(/runtime/i);
    expect(toUserMessage(new AppError("fatalSession"))).toMatch(/session/i);
  });

  it("collapses raw errors to the generic server message", () => {
    expect(toUserMessage(new Error("ECONNREFUSED 10.0.0.1:5432"))).toMatch(/something went wrong/i);
    expect(toUserMessage("postgres exploded")).toMatch(/something went wrong/i);
    expect(toUserMessage(undefined)).toMatch(/something went wrong/i);
  });
});

describe("sanitizeServerMessage (display boundary, FR-080)", () => {
  it("passes short clean messages", () => {
    expect(sanitizeServerMessage("Task title is required")).toBe("Task title is required");
  });

  it("rejects messages over 300 chars", () => {
    expect(sanitizeServerMessage("a".repeat(301))).toBeNull();
  });

  it("rejects path, db, and stack markers regardless of case", () => {
    for (const bad of [
      "ENOENT: no such file /home/matrix/x",
      "error at /Users/hamed/dev",
      "/opt/matrix/app failed",
      "ECONNREFUSED",
      "Postgres connection lost",
      "syntax error in SQL statement",
      "Error\n    at stack frame",
      "Traceback (most recent call last)",
    ]) {
      expect(sanitizeServerMessage(bad)).toBeNull();
    }
  });

  it("rejects non-strings", () => {
    expect(sanitizeServerMessage(42)).toBeNull();
    expect(sanitizeServerMessage({ message: "x" })).toBeNull();
  });
});
