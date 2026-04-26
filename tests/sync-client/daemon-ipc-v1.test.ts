import { describe, expect, it } from "vitest";
import {
  DaemonRequestSchema,
  formatDaemonError,
  formatDaemonSuccess,
  parseDaemonRequest,
} from "../../packages/sync-client/src/daemon/types.js";

describe("daemon IPC v1 envelopes", () => {
  it("requires protocol version 1 and bounded command names", () => {
    expect(DaemonRequestSchema.parse({ id: "1", v: 1, command: "shell.list", args: {} }).command).toBe("shell.list");
    expect(() => DaemonRequestSchema.parse({ id: "1", command: "shell.list", args: {} })).toThrow();
  });

  it("returns stable errors for unknown commands", () => {
    expect(parseDaemonRequest({ id: "1", v: 1, command: "unknown", args: {} })).toEqual({
      ok: false,
      response: formatDaemonError("1", "unknown_command"),
    });
  });

  it("returns stable errors for unsupported versions", () => {
    expect(parseDaemonRequest({ id: "1", v: 2, command: "shell.list", args: {} })).toEqual({
      ok: false,
      response: formatDaemonError("1", "unsupported_version"),
    });
  });

  it("formats versioned success envelopes", () => {
    expect(formatDaemonSuccess("1", { sessions: [] })).toEqual({
      id: "1",
      v: 1,
      result: { sessions: [] },
    });
  });
});
