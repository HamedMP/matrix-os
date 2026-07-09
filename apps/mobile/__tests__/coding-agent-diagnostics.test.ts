import {
  formatMobileCodingAgentDiagnostic,
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
      "link-local 169.254.10.20",
      "socket /run/matrix/gateway.sock",
      "windows C:\\Users\\alice\\matrix\\token.txt",
      "postgres://matrix:secret@10.0.0.8:5432/runtime",
    ].join(" ");

    const redacted = redactMobileCodingAgentDiagnosticText(text);

    expect(redacted).toContain("[path]");
    expect(redacted).toContain("[token]");
    expect(redacted).toContain("[url]");
    expect(redacted).toContain("[host]");
    expect(redacted.length).toBeLessThanOrEqual(180);
    expect(redacted).not.toMatch(/\/home\/matrix|\/run\/matrix|C:\\Users|alice|private-app|ghp_|internal-runtime|postgres|10\.0\.0\.8|169\.254\.10\.20|secret/i);
  });

  it("avoids duplicate token placeholders for authorization headers", () => {
    const redacted = redactMobileCodingAgentDiagnosticText("Authorization: Bearer ghp_privatevalue1234567890");

    expect(redacted).toBe("Authorization: [token]");
  });

  it("redacts private ipv6 diagnostic hosts", () => {
    const redacted = redactMobileCodingAgentDiagnosticText("connect ::1 fe80::1 fd12:3456:789a::1");

    expect(redacted).toBe("connect [host] [host] [host]");
  });

  it("bounds long diagnostic text", () => {
    const redacted = redactMobileCodingAgentDiagnosticText(`status ${"x".repeat(220)}`);

    expect(redacted).toHaveLength(180);
    expect(redacted.endsWith("...")).toBe(true);
  });

  it("formats non-error diagnostics and unsafe names safely", () => {
    const unknown = formatMobileCodingAgentDiagnostic("token=sk_live_private /tmp/private-file");
    const unsafeNameError = new Error("failed");
    const tokenNameError = new Error("failed");
    unsafeNameError.name = "!!!";
    tokenNameError.name = "sk_live_private_name";

    expect(unknown).toEqual({
      name: "Unknown",
      message: "token= [token] [path]",
    });
    expect(formatMobileCodingAgentDiagnostic(unsafeNameError)).toEqual({
      name: "Error",
      message: "failed",
    });
    expect(formatMobileCodingAgentDiagnostic(tokenNameError)).toEqual({
      name: "token",
      message: "failed",
    });
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

  it("redacts exported scope labels defensively", () => {
    const warn = jest.fn();

    logMobileCodingAgentWarning("database probe /home/matrix/home token=ghp_private123", "status 500", { warn });

    expect(warn).toHaveBeenCalledWith(
      "[mobile] [database] probe [path] token= [token]",
      expect.objectContaining({ message: "status 500" }),
    );
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/\/home\/matrix|ghp_private123/i);
  });
});
