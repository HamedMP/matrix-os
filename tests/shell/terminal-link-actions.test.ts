// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  activateTerminalLink,
  copyTerminalLink,
  openTerminalLink,
  type TerminalLinkEntry,
} from "../../shell/src/components/terminal/terminal-links.js";

const LINK: TerminalLinkEntry = {
  url: "https://example.com/docs",
  hostname: "example.com",
  displayPath: "/docs",
  kind: "web",
};

const originalClipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
const originalExecCommandDescriptor = Object.getOwnPropertyDescriptor(document, "execCommand");

describe("terminal link actions", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    if (originalClipboardDescriptor) {
      Object.defineProperty(navigator, "clipboard", originalClipboardDescriptor);
    } else {
      Reflect.deleteProperty(navigator, "clipboard");
    }
    if (originalExecCommandDescriptor) {
      Object.defineProperty(document, "execCommand", originalExecCommandDescriptor);
    } else {
      Reflect.deleteProperty(document, "execCommand");
    }
  });

  it("opens a safe link in a separate browser target", () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    openTerminalLink(LINK);
    expect(open).toHaveBeenCalledWith(
      "https://example.com/docs",
      "_blank",
      "noopener,noreferrer",
    );
  });

  it("does not activate a terminal link from a secondary-button click", () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);

    activateTerminalLink({ button: 2 }, LINK.url);

    expect(open).not.toHaveBeenCalled();
  });

  it("activates a safe terminal link from a primary-button click", () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);

    activateTerminalLink({ button: 0 }, LINK.url);

    expect(open).toHaveBeenCalledWith(
      "https://example.com/docs",
      "_blank",
      "noopener,noreferrer",
    );
  });

  it("does not activate an unsafe OSC hyperlink", () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);

    activateTerminalLink({ button: 0 }, "https://user:pass@example.com/private");

    expect(open).not.toHaveBeenCalled();
  });

  it("copies a link with the Clipboard API", () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    copyTerminalLink(LINK);
    expect(writeText).toHaveBeenCalledWith("https://example.com/docs");
  });

  it("falls back to document copy when the Clipboard API rejects", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const execCommand = vi.fn().mockReturnValue(true);
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: execCommand,
    });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    copyTerminalLink(LINK);
    await Promise.resolve();

    expect(execCommand).toHaveBeenCalledWith("copy");
    expect(document.querySelector("textarea")).toBeNull();
  });
});
