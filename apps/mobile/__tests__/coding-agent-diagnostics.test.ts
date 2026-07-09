import {
  logMobileCodingAgentWarning,
  redactMobileCodingAgentDiagnosticText,
} from "../lib/coding-agent-diagnostics";

describe("mobile coding-agent diagnostics", () => {
  it("redacts sensitive diagnostic text before logging", () => {
    const text = [
      "failed /home/matrix/home/projects/private-app/src/index.ts",
      "Authorization: Bearer ghp_privatevalue1234567890",
      "url=https://internal-runtime.local/api?token=secret",
      "host=internal-runtime.local probe 10.0.0.8",
      "postgres://matrix:secret@10.0.0.8:5432/runtime",
    ].join(" ");

    const redacted = redactMobileCodingAgentDiagnosticText(text);

    expect(redacted).toContain("[path]");
    expect(redacted).toContain("[token]");
    expect(redacted).toContain("[url]");
    expect(redacted).toContain("[host]");
    expect(redacted.length).toBeLessThanOrEqual(180);
    expect(redacted).not.toMatch(/\/home\/matrix|private-app|ghp_|internal-runtime|postgres|10\.0\.0\.8|secret/i);
  });

  it("logs bounded scope and redacted metadata only", () => {
    const warn = jest.fn();

    logMobileCodingAgentWarning(
      "/api/coding-agents/files/read unavailable",
      new Error("raw file /Users/alice/.ssh/id_rsa token=sk_live_secret"),
      { warn },
    );

    expect(warn).toHaveBeenCalledWith(
      "[mobile] /api/coding-agents/files/read unavailable",
      expect.objectContaining({
        name: "Error",
        message: expect.stringContaining("[path]"),
      }),
    );
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/alice|id_rsa|sk_live_secret/i);
  });
});
