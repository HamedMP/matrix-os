import { describe, expect, it } from "vitest";

import {
  INITIAL_TERMINAL_LINKS_STATE,
  MAX_TERMINAL_LINKS,
  extractTerminalLinks,
  findTerminalLinkAtCell,
  mayContainTerminalLink,
  scanTerminalLinkOutput,
  terminalCellFromPointer,
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

  it("stops links before source-level escape sequences", () => {
    expect(extractTerminalLinks(
      String.raw`https://example.com/docs\nnext`,
    )).toEqual([web("https://example.com/docs")]);
  });

  it("keeps terminal control sequences as URL boundaries", () => {
    expect(extractTerminalLinks(
      "http://localhost:3000\u001b]133;A\u0007/pr-1187:~/projects%",
    )).toEqual([web("http://localhost:3000/")]);
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
    const rejectedProviderShape =
      "https://claude.com/cai/oauth/authorize?response_type=code&client_id=x&state=y";

    expect(extractTerminalLinks(`${claude} ${rejectedProviderShape} https://auth.openai.com/codex/device`))
      .toEqual([
        {
          url: claude,
          hostname: "claude.com",
          displayPath: "/cai/oauth/authorize",
          kind: "claude-auth",
          providerLabel: "Claude Code",
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

  it("does not expose rejected provider OAuth URLs as generic links", () => {
    const unboundCodex = [
      "https://auth.openai.com/oauth/authorize?response_type=code",
      "&client_id=codex&state=state_123",
      "&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback",
      `&code_challenge=${"A".repeat(43)}&code_challenge_method=S256`,
    ].join("");

    expect(extractTerminalLinks(unboundCodex)).toEqual([]);
  });

  it("retains rejected incomplete provider URLs until a later PTY scan completes them", () => {
    const firstChunk = "Go to https://auth.openai.com/codex/";
    const firstScan = scanTerminalLinkOutput(firstChunk);

    expect(firstScan).toEqual({
      entries: [],
      bufferedOutput: "https://auth.openai.com/codex/",
    });
    expect(scanTerminalLinkOutput(`${firstScan.bufferedOutput}device`)).toEqual({
      entries: [{
        url: "https://auth.openai.com/codex/device",
        hostname: "auth.openai.com",
        displayPath: "/codex/device",
        kind: "codex-auth",
        providerLabel: "Codex",
      }],
      bufferedOutput: "",
    });
  });

  it("retains a trailing provider URL fragment when the same scan finds a complete link", () => {
    const firstChunk = [
      "Docs: https://example.com/help",
      "Sign in: https://auth.openai.com/codex/",
    ].join("\n");
    const firstScan = scanTerminalLinkOutput(firstChunk);

    expect(firstScan).toEqual({
      entries: [web("https://example.com/help")],
      bufferedOutput: "https://auth.openai.com/codex/",
    });
    expect(scanTerminalLinkOutput(`${firstScan.bufferedOutput}device`)).toEqual({
      entries: [{
        url: "https://auth.openai.com/codex/device",
        hostname: "auth.openai.com",
        displayPath: "/codex/device",
        kind: "codex-auth",
        providerLabel: "Codex",
      }],
      bufferedOutput: "",
    });
  });

  it("retains a provider fragment across an intervening complete-link scan", () => {
    const fragment = "https://auth.openai.com/codex/";
    const firstScan = scanTerminalLinkOutput(fragment);
    const interveningScan = scanTerminalLinkOutput([
      firstScan.bufferedOutput,
      "Docs: https://example.com/help",
    ].join("\n"));

    expect(interveningScan).toEqual({
      entries: [web("https://example.com/help")],
      bufferedOutput: fragment,
    });
    expect(scanTerminalLinkOutput(`${interveningScan.bufferedOutput}device`).entries)
      .toEqual([{
        url: "https://auth.openai.com/codex/device",
        hostname: "auth.openai.com",
        displayPath: "/codex/device",
        kind: "codex-auth",
        providerLabel: "Codex",
      }]);
  });

  it("keeps only the provider fragment when unrelated output intervenes", () => {
    const fragment = "https://auth.openai.com/codex/";
    const firstScan = scanTerminalLinkOutput(`Sign in: ${fragment}`);
    const interveningScan = scanTerminalLinkOutput(
      `${firstScan.bufferedOutput}\nStill working...`,
    );

    expect(firstScan.bufferedOutput).toBe(fragment);
    expect(interveningScan).toEqual({ entries: [], bufferedOutput: fragment });
    expect(scanTerminalLinkOutput(`${interveningScan.bufferedOutput}device`).entries[0]?.kind)
      .toBe("codex-auth");
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

  it("maps a pointer to the public xterm viewport cell grid", () => {
    const screen = {
      getBoundingClientRect: () => ({
        left: 100,
        top: 50,
        width: 800,
        height: 480,
        right: 900,
        bottom: 530,
        x: 100,
        y: 50,
        toJSON: () => ({}),
      }),
    };
    const terminal = {
      cols: 80,
      rows: 24,
      element: { querySelector: () => screen },
      buffer: { active: { viewportY: 5 } },
    };

    expect(terminalCellFromPointer(terminal as never, 250, 90)).toEqual({
      column: 16,
      bufferLineNumber: 8,
    });
    expect(terminalCellFromPointer(terminal as never, 99, 90)).toBeNull();
    expect(terminalCellFromPointer(terminal as never, 250, 531)).toBeNull();
  });

  it("finds a wrapped URL only when the target cell is inside its range", () => {
    const lines = [
      { isWrapped: false, translateToString: () => "Go https://example.c" },
      { isWrapped: true, translateToString: () => "om/docs rest" },
      { isWrapped: false, translateToString: () => "No URL here" },
    ];
    const terminal = {
      buffer: {
        active: {
          length: lines.length,
          getLine: (index: number) => lines[index],
        },
      },
    };

    expect(findTerminalLinkAtCell(terminal as never, {
      bufferLineNumber: 1,
      column: 15,
    })).toEqual(web("https://example.com/docs"));
    expect(findTerminalLinkAtCell(terminal as never, {
      bufferLineNumber: 2,
      column: 3,
    })).toEqual(web("https://example.com/docs"));
    expect(findTerminalLinkAtCell(terminal as never, {
      bufferLineNumber: 2,
      column: 8,
    })).toBeNull();
    expect(findTerminalLinkAtCell(terminal as never, {
      bufferLineNumber: 3,
      column: 2,
    })).toBeNull();
  });
});
