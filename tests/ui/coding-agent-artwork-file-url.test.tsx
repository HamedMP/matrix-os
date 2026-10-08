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
      claude: "agents/settings/claude.svg",
      codex: "agents/settings/openai.svg",
      hermes: "agent-logos/hermes-agent.png",
      openclaw: "agent-logos/openclaw.svg",
      opencode: "agent-logos/opencode-white.png",
      pi: "agent-logos/pi-coding-agent.png",
    } as const;

    for (const [harness, filename] of Object.entries(expected)) {
      const { container, unmount } = render(<HarnessIcon harness={harness as keyof typeof expected} />);
      const src = container.querySelector("img")?.getAttribute("src");
      expect(src).toBe(`./${filename}`);
      expect(new URL(src!, document.baseURI).pathname).toBe(
        `/Applications/Matrix%20OS.app/Contents/Resources/app.asar/out/renderer/${filename}`,
      );
      unmount();
    }
  });

  it("keeps web artwork rooted at the public asset directory on nested routes", () => {
    setDocumentBase("https://app.matrix-os.com/vm/review/settings");
    const { container } = render(<HarnessIcon harness="codex" />);
    const src = container.querySelector("img")?.getAttribute("src");
    expect(src).toBe("/vm/review/agents/settings/openai.svg");
    expect(new URL(src!, document.baseURI).pathname).toBe("/vm/review/agents/settings/openai.svg");
  });
});
