import { describe, expect, it } from "vitest";

import {
  INITIAL_TERMINAL_LINKS_STATE,
  MAX_TERMINAL_LINKS,
  extractTerminalLinks,
  mayContainTerminalLink,
  terminalLinksReducer,
  type TerminalLinkEntry,
} from "../../shell/src/components/terminal/terminal-links.js";

function web(url: string): TerminalLinkEntry {
  const parsed = new URL(url);
  return {
    url: parsed.toString(),
    hostname: parsed.host,
    displayPath: parsed.pathname,
    kind: "web",
  };
}

describe("terminal links", () => {
  it("extracts every HTTP(S) URL and strips terminal control sequences", () => {
    expect(extractTerminalLinks(
      "\u001b[36mDocs\u001b[0m https://example.com/a and http://localhost:3000/b",
    )).toEqual([
      web("https://example.com/a"),
      web("http://localhost:3000/b"),
    ]);
  });

  it("normalizes and deduplicates URLs in output order", () => {
    expect(extractTerminalLinks(
      "https://example.com https://example.com/ https://example.com/docs?q=1#intro",
    )).toEqual([
      web("https://example.com/"),
      {
        ...web("https://example.com/docs"),
        url: "https://example.com/docs?q=1#intro",
        displayPath: "/docs",
      },
    ]);
  });

  it("rejects credentials, unsupported schemes, malformed URLs, and oversized URLs", () => {
    const oversized = `https://example.com/${"a".repeat(2050)}`;
    expect(extractTerminalLinks([
      "https://user:pass@example.com/private",
      "javascript:alert(1)",
      "https://%zz",
      oversized,
    ].join(" "))).toEqual([]);
  });

  it("classifies only strictly validated provider login URLs as trusted auth", () => {
    const challenge = "A".repeat(43);
    const claude = [
      "https://claude.com/cai/oauth/authorize?code=true",
      "&client_id=claude-cli&response_type=code",
      "&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback",
      `&code_challenge=${challenge}&code_challenge_method=S256&state=state_456`,
    ].join("");
    const invalidProviderShape =
      "https://claude.com/cai/oauth/authorize?response_type=code&client_id=x&state=y";

    expect(extractTerminalLinks(`${claude} ${invalidProviderShape} https://auth.openai.com/codex/device`))
      .toEqual([
        {
          url: claude,
          hostname: "claude.com",
          displayPath: "/cai/oauth/authorize",
          kind: "claude-auth",
          providerLabel: "Claude Code",
        },
        {
          url: invalidProviderShape,
          hostname: "claude.com",
          displayPath: "/cai/oauth/authorize",
          kind: "web",
        },
        {
          url: "https://auth.openai.com/codex/device",
          hostname: "auth.openai.com",
          displayPath: "/codex/device",
          kind: "codex-auth",
          providerLabel: "Codex",
        },
      ]);
  });

  it("cheaply detects output worth scanning for generic links", () => {
    expect(mayContainTerminalLink("Visit https://example.com/docs")).toBe(true);
    expect(mayContainTerminalLink("Visit http://localhost:3000")).toBe(true);
    expect(mayContainTerminalLink("No links here")).toBe(false);
  });

  it("expands for a new link and ignores repeated output after dismissal", () => {
    const first = terminalLinksReducer(INITIAL_TERMINAL_LINKS_STATE, {
      type: "linksDetected",
      entries: [web("https://one.example/a")],
    });
    expect(first.presentation).toBe("expanded");
    expect(first.activeUrl).toBe("https://one.example/a");

    const dismissed = terminalLinksReducer(first, { type: "dismiss" });
    expect(terminalLinksReducer(dismissed, {
      type: "linksDetected",
      entries: [web("https://one.example/a")],
    })).toEqual(dismissed);

    const withNewLink = terminalLinksReducer(dismissed, {
      type: "linksDetected",
      entries: [web("https://two.example/b")],
    });
    expect(withNewLink.presentation).toBe("expanded");
    expect(withNewLink.entries.map((entry) => entry.url)).toEqual([
      "https://two.example/b",
      "https://one.example/a",
    ]);
  });

  it("collapses without losing links and resets pane-local state", () => {
    const detected = terminalLinksReducer(INITIAL_TERMINAL_LINKS_STATE, {
      type: "linksDetected",
      entries: [web("https://one.example/a")],
    });
    expect(terminalLinksReducer(detected, { type: "collapse" })).toEqual({
      ...detected,
      presentation: "collapsed",
    });
    expect(terminalLinksReducer(detected, { type: "reset" }))
      .toEqual(INITIAL_TERMINAL_LINKS_STATE);
  });

  it("retains only the twenty most recent unique links", () => {
    const entries = Array.from(
      { length: MAX_TERMINAL_LINKS + 1 },
      (_, index) => web(`https://example.com/${index}`),
    );
    const state = terminalLinksReducer(INITIAL_TERMINAL_LINKS_STATE, {
      type: "linksDetected",
      entries,
    });

    expect(state.entries).toHaveLength(MAX_TERMINAL_LINKS);
    expect(state.entries[0]?.url).toBe("https://example.com/20");
    expect(state.entries.at(-1)?.url).toBe("https://example.com/1");
  });
});
