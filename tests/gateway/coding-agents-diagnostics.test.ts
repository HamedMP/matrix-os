import { describe, expect, it, vi } from "vitest";
import {
  formatCodingAgentDiagnostic,
  logCodingAgentWarning,
  redactCodingAgentDiagnosticText,
} from "../../packages/gateway/src/coding-agents/diagnostics.js";

describe("coding agent diagnostics", () => {
  it("redacts sensitive paths, hosts, tokens, urls, and database details", () => {
    const raw = [
      "failed to open /home/matrix/home/projects/private-app/src/index.ts",
      "token=sk_live_51_private_secret",
      "Authorization: Bearer ghp_privatevalue1234567890",
      "postgres://matrix:password@10.0.0.5:5432/runtime",
      "host internal-runtime.local",
      "ENOENT",
    ].join(" ");

    const redacted = redactCodingAgentDiagnosticText(raw);

    expect(redacted).toContain("[path]");
    expect(redacted).toContain("[token]");
    expect(redacted).toContain("[url]");
    expect(redacted).toContain("[host]");
    expect(redacted.length).toBeLessThanOrEqual(180);
    expect(redacted).not.toMatch(/\/home\/matrix|private-app|sk_live|ghp_|postgres|10\.0\.0\.5|internal-runtime/i);
  });

  it("formats bounded error diagnostics without leaking raw values", () => {
    const diagnostic = formatCodingAgentDiagnostic(
      new Error("Provider said /Users/alice/.ssh/id_rsa failed with xoxb-secret and db timeout"),
    );

    expect(diagnostic.name).toBe("Error");
    expect(diagnostic.message).toContain("[path]");
    expect(diagnostic.message).toContain("[token]");
    expect(diagnostic.message).toContain("[database]");
    expect(JSON.stringify(diagnostic)).not.toMatch(/alice|id_rsa|xoxb-secret|db timeout/i);
  });

  it("logs only coarse scope and redacted diagnostics", () => {
    const warn = vi.fn();

    logCodingAgentWarning(
      "summary route failed",
      new Error("raw path /opt/matrix/release.json leaked token=secret-value"),
      { warn },
    );

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      "[coding-agents] summary route failed",
      expect.objectContaining({
        name: "Error",
        message: expect.stringContaining("[path]"),
      }),
    );
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/\/opt\/matrix|secret-value/i);
  });
});
