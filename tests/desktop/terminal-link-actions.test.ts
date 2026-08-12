// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DesktopWebLinkProvider,
  activateDesktopTerminalLink,
  copyDesktopTerminalLink,
  findDesktopTerminalLinkAtCell,
  resolveDesktopTerminalLink,
} from "@desktop/renderer/src/features/terminal/terminal-link-actions";

const LINK = {
  url: "https://example.org/final-check",
  hostname: "example.org",
  displayPath: "/final-check",
  kind: "web" as const,
};

describe("desktop terminal link actions", () => {
  afterEach(() => vi.restoreAllMocks());

  it("keeps a secondary-button OSC activation inert", () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);

    activateDesktopTerminalLink({ button: 2 }, LINK.url);

    expect(open).not.toHaveBeenCalled();
  });

  it("opens a validated generic URL from a primary-button activation", () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);

    activateDesktopTerminalLink({ button: 0 }, LINK.url);

    expect(open).toHaveBeenCalledWith(
      LINK.url,
      "_blank",
      "noopener,noreferrer",
    );
  });

  it("keeps credential-bearing and rejected provider-shaped URLs inert", () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);

    activateDesktopTerminalLink({ button: 0 }, "https://user:pass@example.org/private");
    activateDesktopTerminalLink(
      { button: 0 },
      "https://auth.openai.com/codex/not-the-device-flow",
    );

    expect(open).not.toHaveBeenCalled();
  });

  it("classifies a trusted Codex login without exposing query values", () => {
    expect(resolveDesktopTerminalLink("https://auth.openai.com/codex/device")).toEqual({
      url: "https://auth.openai.com/codex/device",
      hostname: "auth.openai.com",
      displayPath: "/codex/device",
      kind: "codex-auth",
      providerLabel: "Codex",
    });
  });

  it("copies the exact validated URL", () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    copyDesktopTerminalLink(LINK);

    expect(writeText).toHaveBeenCalledWith(LINK.url);
  });

  it("detects plain-text URLs and does not activate them on secondary click", () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const lines = [{ isWrapped: false, translateToString: () => `Docs: ${LINK.url}` }];
    const provider = new DesktopWebLinkProvider({
      buffer: {
        active: {
          length: lines.length,
          getLine: (index: number) => lines[index],
        },
      },
    } as never);
    let provided: Array<{ text: string; activate: (event: MouseEvent) => void }> | undefined;

    provider.provideLinks(1, (links) => {
      provided = links;
    });
    provided?.[0]?.activate({ button: 2 } as MouseEvent);

    expect(provided?.[0]?.text).toBe(LINK.url);
    expect(open).not.toHaveBeenCalled();
  });

  it("reports the resolved plain-text link while it is hovered", () => {
    const lines = [{ isWrapped: false, translateToString: () => `Docs: ${LINK.url}` }];
    const onHover = vi.fn();
    const provider = new DesktopWebLinkProvider({
      buffer: {
        active: {
          length: lines.length,
          getLine: (index: number) => lines[index],
        },
      },
    } as never, onHover);
    let provided: Array<{
      hover?: (event: MouseEvent) => void;
      leave?: (event: MouseEvent) => void;
    }> | undefined;

    provider.provideLinks(1, (links) => {
      provided = links;
    });
    provided?.[0]?.hover?.({} as MouseEvent);
    provided?.[0]?.leave?.({} as MouseEvent);

    expect(onHover).toHaveBeenNthCalledWith(1, LINK);
    expect(onHover).toHaveBeenNthCalledWith(2, null);
  });

  it("resolves the URL under a terminal buffer cell", () => {
    const lines = [{ isWrapped: false, translateToString: () => `Docs: ${LINK.url}` }];
    const terminal = {
      buffer: {
        active: {
          length: lines.length,
          getLine: (index: number) => lines[index],
        },
      },
    } as never;

    expect(findDesktopTerminalLinkAtCell(terminal, {
      bufferLineNumber: 1,
      column: 10,
    })).toEqual(LINK);
    expect(findDesktopTerminalLinkAtCell(terminal, {
      bufferLineNumber: 1,
      column: 2,
    })).toBeNull();
  });
});
