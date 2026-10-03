// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import DesktopSurfaceFrame from "@desktop/renderer/src/features/desktop-shell/DesktopSurfaceFrame";
import WorkTab from "@desktop/renderer/src/features/work/WorkTab";
import { ChatAgentsWorkspace } from "@matrix-os/ui";
import { useConnection } from "@desktop/renderer/src/stores/connection";
import { useBoard } from "@desktop/renderer/src/stores/board";
import { useTabs } from "@desktop/renderer/src/stores/tabs";
import { useUi } from "@desktop/renderer/src/stores/ui";
import { clientFixture, saved } from "./chat-agents-fixture";
import type { CanonicalChatClient } from "@desktop/renderer/src/lib/canonical-chat-client";
import type { Tab } from "@desktop/renderer/src/stores/tabs";

const runtime = vi.hoisted(() => ({ client: null as CanonicalChatClient | null, eventSource: null,
  projectedChatTitles: [], projectChat: vi.fn(), agentDraftRequest: null, requestAgentDraft: vi.fn() }));
vi.mock("@desktop/renderer/src/features/work/WorkSurfaceRuntime", () => ({
  useWorkSurfaceRuntime: () => runtime,
  WorkSurfaceRuntimeProvider: function MockRuntime({ children }: { children: React.ReactNode }) { return <ChatAgentsWorkspace>{children}</ChatAgentsWorkspace>; },
}));
vi.mock("@desktop/renderer/src/features/mission-control/TabContent", () => ({
  TabPane: function MockPane({ tab }: { tab: Tab }) { return <WorkTab tabId={tab.id} active route="chat" initialChatView="draft"/>; },
  TabErrorBoundary: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("@desktop/renderer/src/features/chat/ChatTab", () => ({ default: () => <textarea aria-label="Chat draft" defaultValue="Keep my draft"/> }));
vi.mock("@desktop/renderer/src/features/work/WorkInspector", () => ({ WorkInspector: () => null }));

beforeEach(() => {
  const agents = clientFixture({ matrix: true });
  agents.list.mockResolvedValue({ enabled: true, agents: [saved] });
  runtime.client = { agents, list: vi.fn(async () => ({ items: [] })) } as unknown as CanonicalChatClient;
  useConnection.setState(useConnection.getInitialState(), true);
  useBoard.setState({ projects: [], loadProjects: vi.fn(async () => undefined) });
  useTabs.setState(useTabs.getInitialState(), true);
  useUi.setState(useUi.getInitialState(), true);
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, value: 1400 });
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it.each(["window", "tab"] as const)("shows Agents titles on the sole real native toolbar in %s mode", async mode => {
  render(<DesktopSurfaceFrame tab={{ id: "work", kind: "work", title: "Chat", workRoute: "chat", chatView: "draft", closable: false }}
    surface={{ tabId: "work", mode, restoreMode: "window", bounds: { x: 0, y: 0, width: 1400, height: 900 }, zIndex: 1 }}
    active tabWorkspaceActive={mode === "tab"} overlayOpen={false} presentation="desktop"
    onFocus={vi.fn()} onClose={vi.fn()} onMinimize={vi.fn()} onMaximize={vi.fn()} onBoundsChange={vi.fn()}/>);
  const toolbar = screen.getByTestId("os-window-chrome-grid");
  expect(toolbar.textContent).not.toContain("Chat"); // Preserve ordinary draft chrome.
  const draft = screen.getByRole("textbox", { name: "Chat draft" });
  fireEvent.click(await screen.findByRole("button", { name: "Add new agent" }));
  await waitFor(() => expect(within(toolbar).getByText("New agent")).toBeTruthy());
  expect(document.querySelectorAll('[data-testid="os-window-chrome-grid"]')).toHaveLength(1);
  expect(screen.queryByRole("button", { name: "Back to Chat" })).toBeNull();
  expect(draft.isConnected).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Agents", exact: true }));
  await waitFor(() => expect(within(toolbar).getByText("Your AI team")).toBeTruthy());
  fireEvent.click(await screen.findByRole("button", { name: `Edit ${saved.name}` }));
  await waitFor(() => expect(within(toolbar).getByText("Edit agent")).toBeTruthy());
  fireEvent.click(screen.getByRole("button", { name: "Close agent settings" }));
  await waitFor(() => expect(within(toolbar).getByText("Your AI team")).toBeTruthy());
  fireEvent.click(screen.getByRole("button", { name: "New Agent", exact: true }));
  await waitFor(() => expect(within(toolbar).getByText("New agent")).toBeTruthy());
  fireEvent.click(screen.getByRole("button", { name: "Close agent settings" }));
  fireEvent.click(screen.getByRole("button", { name: "New chat", exact: true }));
  await waitFor(() => expect(toolbar.textContent).not.toMatch(/New agent|Your AI team|Edit agent/));
  expect(screen.getByRole("textbox", { name: "Chat draft" })).toBe(draft);
  expect((draft as HTMLTextAreaElement).value).toBe("Keep my draft");
});
