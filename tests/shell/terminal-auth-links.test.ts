import { describe, expect, it } from "vitest";

import {
  extractTrustedTerminalAuthLink,
  mayContainTerminalAuthLink,
} from "../../shell/src/components/terminal/terminal-auth-links.js";

describe("terminal auth links", () => {
  it("extracts a trusted Claude Code OAuth URL from ANSI terminal output", () => {
    const raw = [
      "\u001b[36mOpen this URL:\u001b[0m ",
      "https://claude.ai/oauth/authorize?response_type=code&client_id=claude-cli&state=state_123",
    ].join("");

    expect(extractTrustedTerminalAuthLink(raw)).toEqual({
      provider: "claude",
      providerLabel: "Claude Code",
      url: "https://claude.ai/oauth/authorize?response_type=code&client_id=claude-cli&state=state_123",
    });
  });

  it("extracts the Codex device login URL", () => {
    const raw = "Go to https://auth.openai.com/codex/device and enter the code shown below.";

    expect(extractTrustedTerminalAuthLink(raw)).toEqual({
      provider: "codex",
      providerLabel: "Codex",
      url: "https://auth.openai.com/codex/device",
    });
  });

  it("extracts a trusted Codex browser OAuth URL", () => {
    const raw = [
      "https://auth.openai.com/oauth/authorize?response_type=code",
      "&client_id=app_EMoamEEZ73f0CkXaXp7hrann&state=state_456",
      "&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback",
      `&code_challenge=${"A".repeat(43)}&code_challenge_method=S256`,
    ].join("");

    expect(extractTrustedTerminalAuthLink(raw)).toEqual({
      provider: "codex",
      providerLabel: "Codex",
      url: raw,
    });
  });

  it("rejects lookalike hosts, credentials, fragments, and untrusted Codex paths", () => {
    const unsafe = [
      "https://claude.ai.evil.example/oauth/authorize?response_type=code&client_id=x&state=y",
      "https://auth.openai.com.evil.example/codex/device",
      "https://user:pass@auth.openai.com/codex/device",
      "https://auth.openai.com/codex/device#token",
      "https://auth.openai.com/account",
    ];

    for (const raw of unsafe) {
      expect(extractTrustedTerminalAuthLink(raw)).toBeNull();
    }
  });

  it("requires the expected OAuth parameters", () => {
    expect(extractTrustedTerminalAuthLink(
      "https://claude.ai/oauth/authorize?response_type=code&client_id=claude-cli",
    )).toBeNull();
    expect(extractTrustedTerminalAuthLink(
      "https://auth.openai.com/oauth/authorize?response_type=token&client_id=codex&state=state_123",
    )).toBeNull();
    expect(extractTrustedTerminalAuthLink(
      "https://auth.openai.com/oauth/authorize?response_type=code&client_id=app_EMoamEEZ73f0CkXaXp7hrann&state=state_123&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback",
    )).toBeNull();
  });

  it("cheaply identifies output worth scanning without matching unrelated links", () => {
    expect(mayContainTerminalAuthLink("Open https://claude.ai/oauth/authorize?..."))
      .toBe(true);
    expect(mayContainTerminalAuthLink("Open https://auth.openai.com/codex/device"))
      .toBe(true);
    expect(mayContainTerminalAuthLink("Open https://example.com/docs"))
      .toBe(false);
  });
});
