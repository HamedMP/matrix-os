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
      "socket /run/matrix/gateway.sock",
      "windows C:\\Users\\alice\\matrix\\token.txt",
      "host internal-runtime.local",
      "probe 10.0.0.5",
      "ENOENT",
    ].join(" ");

    const redacted = redactCodingAgentDiagnosticText(raw);

    expect(redacted).toContain("[path]");
    expect(redacted).toContain("[token]");
    expect(redacted).toContain("[url]");
    expect(redacted).toContain("[host]");
    expect(redacted.length).toBeLessThanOrEqual(180);
    expect(redacted).not.toMatch(/\/home\/matrix|\/run\/matrix|C:\\Users|alice|private-app|sk_live|ghp_|postgres|10\.0\.0\.5|internal-runtime/i);
  });

  it("bounds long diagnostic text", () => {
    const redacted = redactCodingAgentDiagnosticText(`status ${"x".repeat(220)}`);

    expect(redacted).toHaveLength(180);
    expect(redacted.endsWith("...")).toBe(true);
  });

  it("fully redacts colon-containing and quoted secret assignments", () => {
    const redacted = redactCodingAgentDiagnosticText(
      `token=abc:def apiKey="abcd" password: 'hunter2' Authorization: Basic dXNlcjpwYXNz Authorization: Token tokenpayload TWILIO_AUTH_TOKEN=abc123`,
    );

    expect(redacted).toBe(
      "token= [token] apiKey= [token] password: [token] Authorization: [token] Authorization: [token] TWILIO_AUTH_TOKEN= [token]",
    );
    expect(redacted).not.toMatch(/abc|def|abcd|hunter2|dXNlcjpwYXNz|tokenpayload|abc123/i);
  });

  it("redacts compound credential environment assignments", () => {
    const redacted = redactCodingAgentDiagnosticText(
      `AWS_SECRET_ACCESS_KEY=awsvalue S3_ACCESS_KEY_ID=s3value R2_SECRET_ACCESS_KEY="r2value" PGPASSWORD=pgvalue MONKEY=banana STATUS=healthy`,
    );

    expect(redacted).toBe(
      "AWS_SECRET_ACCESS_KEY= [token] S3_ACCESS_KEY_ID= [token] R2_SECRET_ACCESS_KEY= [token] PGPASSWORD= [token] MONKEY=banana STATUS=healthy",
    );
    expect(redacted).not.toMatch(/awsvalue|s3value|r2value|pgvalue/i);
  });

  it("redacts link-local and private IPv6 hosts", () => {
    const redacted = redactCodingAgentDiagnosticText(
      "metadata 169.254.169.254 loopback ::1 link-local fe80::1 private fd12:3456::1 getaddrinfo ENOTFOUND internal-runtime.local connect ECONNREFUSED matrix-vps.internal localhost",
    );

    expect(redacted).toBe(
      "metadata [host] loopback [host] link-local [host] private [host] getaddrinfo ENOTFOUND [host] connect ECONNREFUSED [host] [host]",
    );
    expect(redacted).not.toMatch(/169\.254|::1|fe80|fd12|internal-runtime|matrix-vps|localhost/i);
  });

  it("formats non-error diagnostics and unsafe names safely", () => {
    const unknown = formatCodingAgentDiagnostic("token=sk_live_private /tmp/private-file");
    const unsafeNameError = new Error("failed");
    unsafeNameError.name = "!!!";

    expect(unknown).toEqual({
      name: "Unknown",
      message: "token= [token] [path]",
    });
    expect(formatCodingAgentDiagnostic(unsafeNameError)).toEqual({
      name: "Error",
      message: "failed",
    });
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
      "database summary route failed",
      new Error("raw path /opt/matrix/release.json leaked token=secret-value"),
      { warn },
    );

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      "[coding-agents] database summary route failed",
      expect.objectContaining({
        name: "Error",
        message: expect.stringContaining("[path]"),
      }),
    );
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/\/opt\/matrix|secret-value/i);
  });
});
