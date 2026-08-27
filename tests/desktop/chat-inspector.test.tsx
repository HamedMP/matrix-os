// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatInspector } from "../../desktop/src/renderer/src/features/chat/ChatInspector";
import { DESKTOP_Z_INDEX } from "../../desktop/src/renderer/src/design/layering";
import {
  createCanonicalChatFixture,
  createCanonicalInspectorFixture,
} from "../contracts/fixtures/canonical-chat";

afterEach(cleanup);
afterEach(() => vi.unstubAllGlobals());

describe("ChatInspector", () => {
  it("renders provider-neutral context, changes, and files from the canonical projection", () => {
    render(
      <ChatInspector
        state="ready"
        projection={createCanonicalInspectorFixture("available")}
      />,
    );

    expect(screen.getByRole("complementary", { name: "Chat details" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: /^Context\b/ }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByText("Matrix OS")).toBeTruthy();
    expect(screen.getByText("HamedMP/matrix-os")).toBeTruthy();
    expect(screen.getByText("Project workspace")).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: /^Changes\b/ }));
    expect(screen.getByText("1 changed file")).toBeTruthy();
    expect(screen.getByText("+20")).toBeTruthy();
    expect(screen.getByText("-1")).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: /^Files\b/ }));
    const filesTab = screen.getByRole("tab", { name: /^Files\b/ });
    const filesPanelId = filesTab.getAttribute("aria-controls");
    const filesPanel = filesPanelId ? document.getElementById(filesPanelId) : null;
    expect(filesPanel).not.toBeNull();
    expect(within(filesPanel!).getByText("packages/gateway/src/routes.ts")).toBeTruthy();
  });

  it("shows Run and Approvals only when canonical data or a canonical slot supports them", () => {
    const fixture = createCanonicalChatFixture("running");
    render(
      <ChatInspector
        state="ready"
        projection={fixture.snapshot.inspector}
        approvals={{ count: 1, content: <div>Approve package changes</div> }}
      />,
    );

    expect(screen.getByRole("tab", { name: /^Run\b/ })).toBeTruthy();
    expect(screen.getByRole("tab", { name: /^Approvals 1$/ })).toBeTruthy();
    expect(screen.queryByRole("tab", { name: /^Files\b/ })).toBeNull();

    fireEvent.click(screen.getByRole("tab", { name: /^Run\b/ }));
    expect(screen.getByText("GPT-5.6-Sol")).toBeTruthy();
    expect(screen.getByText("Codex")).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: /^Approvals 1$/ }));
    expect(screen.getByText("Approve package changes")).toBeTruthy();
  });

  it("renders bounded loading, empty, and error states without provider details", () => {
    const loading = render(<ChatInspector state="loading" />);
    expect(screen.getByRole("status").textContent).toContain("Loading chat details");

    loading.rerender(<ChatInspector state="empty" />);
    expect(screen.getByText("Select a chat to inspect its context and activity.")).toBeTruthy();

    loading.rerender(<ChatInspector state="error" />);
    expect(screen.getByRole("alert").textContent).toContain("Chat details couldn't be loaded");
  });

  it("keeps canonical tabs keyboard navigable", () => {
    render(
      <ChatInspector
        state="ready"
        projection={createCanonicalInspectorFixture("available")}
      />,
    );

    const context = screen.getByRole("tab", { name: /^Context\b/ });
    context.focus();
    fireEvent.keyDown(context, { key: "ArrowRight" });
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: /^Changes\b/ }));
  });

  it("mounts a non-default controlled tab on the first render and retains its live surface", () => {
    const projection = createCanonicalInspectorFixture("available");
    const view = render(
      <ChatInspector
        state="ready"
        projection={projection}
        defaultTab="context"
        selectedTab="files"
      />,
    );

    const filesTab = screen.getByRole("tab", { name: /^Files\b/ });
    const filesPanel = document.getElementById(filesTab.getAttribute("aria-controls")!);
    expect(filesPanel).not.toBeNull();
    expect(within(filesPanel!).getByText("packages/gateway/src/routes.ts")).toBeTruthy();

    view.rerender(
      <ChatInspector
        state="ready"
        projection={projection}
        defaultTab="context"
        selectedTab="context"
      />,
    );

    expect(filesPanel!.hidden).toBe(true);
    expect(within(filesPanel!).getByText("packages/gateway/src/routes.ts")).toBeTruthy();
  });

  it("keeps tab tooltips inside the centralized desktop popover layer", async () => {
    render(
      <ChatInspector
        state="ready"
        projection={createCanonicalInspectorFixture("available")}
      />,
    );

    fireEvent.focus(screen.getByRole("tab", { name: /^Context\b/ }));

    await waitFor(() => {
      const tooltipSurface = document.querySelector<HTMLElement>("[data-side][data-align]");
      expect(tooltipSurface).not.toBeNull();
      expect(tooltipSurface!.style.zIndex).toBe(String(DESKTOP_Z_INDEX.popover));
    });
  });
});
