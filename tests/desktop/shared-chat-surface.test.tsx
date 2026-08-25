// @vitest-environment jsdom

import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { SharedChatSurface } from "../../desktop/src/renderer/src/features/chat/SharedChatSurface";

describe("SharedChatSurface", () => {
  afterEach(cleanup);

  it.each([
    ["global", undefined],
    ["project", { projectId: "matrix-os", label: "Matrix OS" }],
  ] as const)("keeps the same composition for %s Chat", (_name, project) => {
    render(
      <SharedChatSurface ariaLabel="Chat" project={project}>
        <div data-testid="timeline" />
        <div data-testid="composer" />
      </SharedChatSurface>,
    );

    const surface = screen.getByRole("region", { name: "Chat" });
    expect(surface.getAttribute("data-slot")).toBe("shared-chat-surface");
    expect(surface.getAttribute("data-chat-context")).toBe(project ? "project" : "global");
    expect(surface.contains(screen.getByTestId("timeline"))).toBe(true);
    expect(surface.contains(screen.getByTestId("composer"))).toBe(true);
  });
});
