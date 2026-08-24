// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConversationProviderSelector } from "../../desktop/src/renderer/src/components/conversation/provider-selector";
import type { ConversationProviderOption } from "../../desktop/src/renderer/src/components/conversation/provider-options";

describe("conversation provider selector", () => {
  afterEach(cleanup);

  it("renders the Figma-sized provider badge and explains disabled providers", () => {
    const options: ConversationProviderOption[] = [
      {
        id: "hermes",
        label: "Hermes",
        icon: "hermes",
        capabilities: ["current-conversation", "tools"],
        readiness: { state: "ready" },
      },
      {
        id: "codex",
        label: "Codex",
        icon: "codex",
        capabilities: ["project-conversation", "tools"],
        readiness: { state: "disabled", reason: "Create a project to use Codex." },
      },
    ];

    render(
      <ConversationProviderSelector
        value="hermes"
        options={options}
        onSelect={vi.fn()}
        renderIcon={(icon) => <span data-testid={`provider-icon-${icon}`} />}
      />,
    );

    const trigger = screen.getByRole("button", { name: "Chat harness" });
    expect(trigger.className).toContain("h-5");
    expect(trigger.className).toContain("rounded-full");
    expect(trigger.className).not.toContain("w-full");
    expect(trigger.getAttribute("title")).toBe("Hermes · Current conversation, Tools");

    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });

    expect(screen.getByTestId("provider-icon-hermes")).toBeTruthy();
    const codex = screen.getByRole("menuitemradio", { name: "Codex Create a project to use Codex." });
    expect(codex.getAttribute("data-disabled")).not.toBeNull();
  });
});
