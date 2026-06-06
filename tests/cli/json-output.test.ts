import { describe, expect, it } from "vitest";
import {
  formatCliError,
  formatCliSuccess,
  formatNdjsonEvent,
} from "../../packages/sync-client/src/cli/output.js";

describe("CLI machine-readable output", () => {
  it("formats versioned success envelopes", () => {
    expect(formatCliSuccess({ sessions: [] })).toBe(
      JSON.stringify({ v: 1, ok: true, data: { sessions: [] } }),
    );
  });

  it("formats generic stable error envelopes", () => {
    expect(formatCliError("zellij_failed")).toBe(
      JSON.stringify({
        v: 1,
        error: {
          code: "zellij_failed",
          message: "Shell backend unavailable. Your Matrix OS instance could not start a shell session.",
        },
      }),
    );
  });

  it("formats known CLI network errors with safe messages", () => {
    expect(JSON.parse(formatCliError("platform_unreachable"))).toEqual({
      v: 1,
      error: {
        code: "platform_unreachable",
        message: "Platform unreachable. Matrix CLI could not contact the Matrix OS platform.",
      },
    });
    expect(JSON.parse(formatCliError("gateway_unreachable"))).toEqual({
      v: 1,
      error: {
        code: "gateway_unreachable",
        message: "Gateway unreachable. Matrix CLI could not contact your Matrix OS instance.",
      },
    });
  });

  it("formats login failures with actionable safe guidance", () => {
    expect(JSON.parse(formatCliError("login_failed"))).toEqual({
      v: 1,
      error: {
        code: "login_failed",
        message: "Login failed. Run `mos login` to retry.",
      },
    });
  });

  it("formats attach timeouts with actionable safe guidance", () => {
    expect(JSON.parse(formatCliError("attach_timeout"))).toEqual({
      v: 1,
      error: {
        code: "attach_timeout",
        message: "Shell attach timed out. Try again or run `mos doctor`.",
      },
    });
  });

  it("formats shell backend dependency failures with safe guidance", () => {
    expect(JSON.parse(formatCliError("shell_backend_unavailable"))).toEqual({
      v: 1,
      error: {
        code: "shell_backend_unavailable",
        message: "Shell backend unavailable. Run `mos doctor` for diagnostics.",
      },
    });
  });

  it("formats NDJSON stream events", () => {
    expect(formatNdjsonEvent("output", { bytes: "abc" })).toBe(
      `${JSON.stringify({ v: 1, type: "output", data: { bytes: "abc" } })}\n`,
    );
  });
});
