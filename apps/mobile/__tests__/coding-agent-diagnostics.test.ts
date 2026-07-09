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
    ].join("\n");

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

  it("redacts complete authorization header values for every auth scheme", () => {
    const redacted = redactMobileCodingAgentDiagnosticText([
      "Authorization: Basic dXNlcjpwYXNzd29yZA==",
      "Authorization: Token private-value",
      'Authorization: Digest username="alice", response="private-response"',
    ].join("\n"));

    expect(redacted).toBe([
      "Authorization: [token]",
      "Authorization: [token]",
      "Authorization: [token]",
    ].join(" "));
    expect(redacted).not.toMatch(/dXNlcj|private-value|alice|private-response/);
  });

  it("preserves the assignment separator without leaking secret fragments", () => {
    const redacted = redactMobileCodingAgentDiagnosticText(
      `token=abc:def apiKey="quoted private value" password: 'hunter2:private'`,
    );

    expect(redacted).toBe("token= [token] apiKey= [token] password: [token]");
    expect(redacted).not.toMatch(/abc|def|quoted|private|hunter2/);
  });

  it("redacts compound secret keys without redacting unrelated assignments", () => {
    const redacted = redactMobileCodingAgentDiagnosticText(
      "AWS_SECRET_ACCESS_KEY=aws-private clientSecret=client-private privateKey=key-private idToken=id-private PGPASSWORD=pg-private MONKEY=banana",
    );

    expect(redacted).toBe(
      "AWS_SECRET_ACCESS_KEY= [token] clientSecret= [token] privateKey= [token] idToken= [token] PGPASSWORD= [token] MONKEY=banana",
    );
    expect(redacted).not.toMatch(/aws-private|client-private|key-private|id-private|pg-private/);
  });

  it("redacts private ipv6 diagnostic hosts", () => {
    const redacted = redactMobileCodingAgentDiagnosticText("connect ::1 fe80::1 fe90::2%en0 fd12:3456:789a::1");

    expect(redacted).toBe("connect [host] [host] [host] [host]");
  });

  it("redacts assignment-prefixed owner paths and unlabeled private hosts", () => {
    const redacted = redactMobileCodingAgentDiagnosticText(
      "read path=/home/matrix/private.ts ENOTFOUND internal-runtime.local connect localhost",
    );

    expect(redacted).toBe("read path=[path] ENOTFOUND [host] connect [host]");
    expect(redacted).not.toMatch(/\/home\/matrix|private\.ts|internal-runtime|localhost/);
  });

  it("redacts backtick-quoted owner paths", () => {
    const redacted = redactMobileCodingAgentDiagnosticText(
      "open `/home/matrix/home/project/file.ts` failed",
    );

    expect(redacted).toBe("open `[path]` failed");
    expect(redacted).not.toMatch(/\/home\/matrix|project|file\.ts/);
  });

  it("redacts single-label hosts in network errors", () => {
    const redacted = redactMobileCodingAgentDiagnosticText(
      "getaddrinfo ENOTFOUND internal-runtime connect ECONNREFUSED matrix-vps",
    );

    expect(redacted).toBe("getaddrinfo ENOTFOUND [host] connect ECONNREFUSED [host]");
    expect(redacted).not.toMatch(/internal-runtime|matrix-vps/);
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
