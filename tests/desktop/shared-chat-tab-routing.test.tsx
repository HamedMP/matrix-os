// @vitest-environment jsdom

import React from "react";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { describe, expect, it, vi } from "vitest";
import { TabPane } from "../../desktop/src/renderer/src/features/mission-control/TabContent";

vi.mock("../../desktop/src/renderer/src/features/work/WorkTab", () => ({
  default: ({ sharedScopeId }: { sharedScopeId?: string }) => (
    <div data-testid="work-tab-shared-scope">{sharedScopeId ?? "missing"}</div>
  ),
}));
vi.mock("../../desktop/src/renderer/src/features/terminal/DesktopSharedTerminal", () => ({
  DesktopSharedTerminal: ({ scopeId: value }: { scopeId: string }) => (
    <div data-testid="desktop-shared-terminal">{value}</div>
  ),
}));

const scopeId = "10000000-0000-4000-8000-000000000001";

describe("Electron shared Chat tab routing", () => {
  it("threads the shared scope through the normalized work tab", () => {
    render(<TabPane tab={{
      id: "work",
      kind: "work",
      title: "Chat",
      closable: false,
      workRoute: "chat",
      chatView: "conversation",
      chatTitle: "Launch plan",
      sharedScopeId: scopeId,
    }} active />);

    expect(screen.getByTestId("work-tab-shared-scope")).toHaveTextContent(scopeId);
  });

  it("opens a shared terminal in the native terminal tab frame", () => {
    render(<TabPane tab={{
      id: "terminal",
      kind: "terminal",
      title: "Shared Terminal",
      closable: true,
      sessionName: `shared:${scopeId}`,
      sharedScopeId: scopeId,
    }} active />);

    expect(screen.getByTestId("desktop-shared-terminal")).toHaveTextContent(scopeId);
  });
});
