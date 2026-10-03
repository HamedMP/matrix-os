// @vitest-environment jsdom
import React from "react";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { codingAgentArtworkSrc } from "../../packages/ui/src/coding-agent-artwork";
import { HarnessIcon } from "../../packages/ui/src/agents-providers/HarnessRail";
import { ConnectionMethodCard } from "../../packages/ui/src/agents-providers/ConnectionMethodCard";

afterEach(() => {
  cleanup();
  window.history.replaceState({}, "", "/");
});

describe("Settings shipped artwork routing", () => {
  it("keeps every Settings SVG on the explicitly selected Preview computer", () => {
    window.history.replaceState({}, "", "/vm/pr-2095?runtime=pr-2095");
    const { container } = render(<>
      <HarnessIcon harness="claude" />
      <HarnessIcon harness="codex" />
      <ConnectionMethodCard title="Account" description="Connect" method="account" disabled={false} />
      <ConnectionMethodCard title="API key" description="Connect" method="key" disabled={false} />
    </>);
    expect(Array.from(container.querySelectorAll("img"), (image) => image.getAttribute("src"))).toEqual(
      ["claude", "openai", "user-round", "key-round"].map(
        (name) => `/vm/pr-2095/~runtime/pr-2095/agents/settings/${name}.svg`,
      ),
    );
  });

  it.each([
    ["https://app.matrix-os.com/", "/agents/settings/openai.svg"],
    ["https://app.matrix-os.com/vm/review/canvas", "/vm/review/agents/settings/openai.svg"],
    ["https://app.matrix-os.com/vm/review?runtime=canary", "/vm/review/~runtime/canary/agents/settings/openai.svg"],
    ["https://app.matrix-os.com/vm/review/~runtime/canary/canvas", "/vm/review/~runtime/canary/agents/settings/openai.svg"],
    ["https://app.matrix-os.com/vm/review/~runtime/canary?runtime=primary", "/vm/review/~runtime/canary/agents/settings/openai.svg"],
    ["https://app.matrix-os.com/settings/vm/review", "/agents/settings/openai.svg"],
    ["https://app.matrix-os.com/vm/review?runtime=../../other", "/vm/review/agents/settings/openai.svg"],
    ["file:///Applications/Matrix.app/Contents/Resources/index.html", "./agents/settings/openai.svg"],
    ["", "/agents/settings/openai.svg"],
    ["invalid-url", "/agents/settings/openai.svg"],
    ["custom://app/vm/review", "/agents/settings/openai.svg"],
  ])("resolves %s without changing the asset", (baseUri, expected) => {
    expect(codingAgentArtworkSrc("/agents/settings/openai.svg", baseUri)).toBe(expected);
  });

  it("leaves non-root asset URLs intact", () => {
    expect(codingAgentArtworkSrc("https://assets.example.test/icon.svg", "https://app.matrix-os.com/vm/review")).toBe("https://assets.example.test/icon.svg");
    expect(codingAgentArtworkSrc("//assets.example.test/icon.svg", "https://app.matrix-os.com/vm/review")).toBe("//assets.example.test/icon.svg");
  });
});
