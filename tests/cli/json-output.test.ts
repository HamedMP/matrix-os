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
        error: { code: "zellij_failed", message: "Request failed" },
      }),
    );
  });

  it("formats NDJSON stream events", () => {
    expect(formatNdjsonEvent("output", { bytes: "abc" })).toBe(
      `${JSON.stringify({ v: 1, type: "output", data: { bytes: "abc" } })}\n`,
    );
  });
});
