// @vitest-environment jsdom

import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConversationProviderSelector } from "../../desktop/src/renderer/src/components/conversation/provider-selector";
import type { ConversationProviderOption } from "../../desktop/src/renderer/src/components/conversation/provider-options";

describe("conversation provider selector", () => {
  afterEach(cleanup);

  it("renders an injected semantic icon and explains disabled providers", () => {
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

    expect(screen.getByTestId("provider-icon-hermes")).toBeTruthy();
    const codex = screen.getByRole("option", { name: "Codex — Create a project to use Codex." });
    expect((codex as HTMLOptionElement).disabled).toBe(true);
    expect(screen.getByLabelText("Chat harness").getAttribute("title")).toBe("Hermes · Current conversation, Tools");
  });
});
