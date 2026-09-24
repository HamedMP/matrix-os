// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { HarnessIcon } from "../../packages/ui/src/agents-providers/HarnessRail";

afterEach(() => {
  cleanup();
  document.head.querySelectorAll("base[data-artwork-test]").forEach((base) => base.remove());
});

function setDocumentBase(href: string): void {
  const base = document.createElement("base");
  base.dataset.artworkTest = "true";
  base.href = href;
  document.head.append(base);
}

describe("shared provider artwork URLs", () => {
  it("resolves each shipped logo inside a packaged Electron renderer", () => {
    setDocumentBase("file:///Applications/Matrix%20OS.app/Contents/Resources/app.asar/out/renderer/index.html");
    const expected = {
      claude: "claude-code.png",
      codex: "codex.png",
      hermes: "hermes-agent.png",
      openclaw: "openclaw.svg",
      opencode: "opencode-white.png",
      pi: "pi-coding-agent.png",
    } as const;

    for (const [harness, filename] of Object.entries(expected)) {
      const { container, unmount } = render(<HarnessIcon harness={harness as keyof typeof expected} />);
      const src = container.querySelector("img")?.getAttribute("src");
      expect(src).toBe(`./agent-logos/${filename}`);
      expect(new URL(src!, document.baseURI).pathname).toBe(
        `/Applications/Matrix%20OS.app/Contents/Resources/app.asar/out/renderer/agent-logos/${filename}`,
      );
      unmount();
    }
  });

  it("keeps web artwork rooted at the public asset directory on nested routes", () => {
    setDocumentBase("https://app.matrix-os.com/vm/review/settings");
    const { container } = render(<HarnessIcon harness="codex" />);
    const src = container.querySelector("img")?.getAttribute("src");
    expect(src).toBe("/agent-logos/codex.png");
    expect(new URL(src!, document.baseURI).pathname).toBe("/agent-logos/codex.png");
  });
});
