// @vitest-environment jsdom

import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CanonicalProviderCatalogSchema, type CanonicalChatQueuedTurn } from "@matrix-os/contracts";
import { ChatApp } from "../../shell/src/components/ChatApp.js";

vi.mock("../../shell/src/components/chat-provider-onboarding", () => ({
  ChatProviderOnboarding: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
const webProjects = vi.hoisted(() => ({ projects: [] as Array<{ id: string; slug: string; name: string; kind?: "scratch" | "github" | "folder" }> }));
vi.mock("../../shell/src/components/chat/web-projects", async (original) => ({
  ...await original<typeof import("../../shell/src/components/chat/web-projects")>(),
  useWebProjects: () => ({ identity: "owner", projects: webProjects.projects, loading: false, error: false, retry: () => {} }),
}));
vi.mock("@clerk/nextjs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@clerk/nextjs")>()),
  useOrganization: () => ({ organization: null }),
  useAuth: () => ({ userId: null, sessionId: null }),
}));

const catalog = CanonicalProviderCatalogSchema.parse({
  revision: "catalog_composer",
  drivers: [{ kind: "pi", displayName: "Pi", adapterVersion: "1.0.0", capabilityClass: "coding_agent" }],
  instances: [{
    id: "pi_default", driverKind: "pi", displayName: "Pi", availability: "available",
    workspaceRequirement: "project_optional",
    models: [{
      id: "anthropic:claude-sonnet-5", displayName: "Claude Sonnet 5", availability: "available",
      capabilities: ["reasoning", "tools"], supportsVision: false, supportsToolUse: true,
    }],
    options: [{
      id: "effort", label: "Reasoning", kind: "enum", placement: "composer",
      values: [{ value: "low", label: "Low" }, { value: "high", label: "High" }], defaultValue: "low",
    }],
    skills: [], commands: [], setupActions: [],
    supports: {
      rootChat: true, resume: true, cancellation: true, attachments: ["file"], tools: [],
      approvals: false, userInput: false, worktrees: "optional", resources: ["project"],
      interactionModes: ["default"], permissionModes: ["supervised", "full_access"],
    },
    defaultSelection: { instanceId: "pi_default", model: "anthropic:claude-sonnet-5" },
    catalogRevision: "catalog_composer",
  }],
});

const queued: CanonicalChatQueuedTurn = {
  id: "cqturn_next", chatId: "chat_composer", clientRequestId: "req_next", position: 1,
  parts: [{ type: "text", text: "Then summarize it" }], selection: { instanceId: "pi_default", model: "anthropic:claude-sonnet-5" },
  interactionMode: "default", permissionMode: "supervised", createdAt: "2026-09-10T00:00:00.000Z", updatedAt: "2026-09-10T00:00:00.000Z",
};

const base = {
  busy: false, connected: true, conversations: [], sessionId: "chat_composer",
  onNewChat: vi.fn(), onSwitchConversation: vi.fn(), onSubmit: vi.fn(),
};
const conversation = [{ id: "msg_1", role: "user" as const, content: "Inspect this run", timestamp: 1000 }];

function toolbar(): HTMLElement {
  const element = document.querySelector<HTMLElement>('[data-slot="prompt-input-toolbar"]');
  if (!element) throw new Error("composer toolbar missing");
  return element;
}

beforeEach(() => {
  webProjects.projects = [];
  window.localStorage.clear();
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => Response.json(catalog)));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("Web Chat composer matches Electron Desktop", () => {
  it("puts attach, model, effort and access controls in the composer toolbar instead of the header", async () => {
    render(<ChatApp {...base} messages={conversation} />);
    await waitFor(() => expect(within(toolbar()).getByRole("button", { name: "Choose model and provider" })).toHaveTextContent("Claude Sonnet 5"));

    const bar = within(toolbar());
    expect(bar.getByRole("button", { name: "Attach files" })).toBeInTheDocument();
    expect(bar.getByRole("button", { name: "Open Agents & providers settings" })).toBeInTheDocument();
    expect(bar.getByRole("button", { name: "Reasoning" })).toHaveTextContent("Low");
    expect(bar.getByRole("button", { name: "Permission mode" })).toHaveTextContent("Supervised");
    expect(bar.getByRole("button", { name: "Send" })).toBeDisabled();

    const header = document.querySelector<HTMLElement>('[data-slot="chat-session-header"]')!;
    expect(within(header).queryByRole("button", { name: /Choose model/ })).toBeNull();
    expect(within(header).queryByRole("button", { name: "Open Agents & providers settings" })).toBeNull();
  });

  it("changes access from the toolbar picker", async () => {
    render(<ChatApp {...base} messages={conversation} />);
    const access = await within(toolbar()).findByRole("button", { name: "Permission mode" });
    fireEvent.click(access);
    fireEvent.click(await screen.findByRole("menuitemradio", { name: "Full Access" }));
    await waitFor(() => expect(within(toolbar()).getByRole("button", { name: "Permission mode" })).toHaveTextContent("Full Access"));
  });

  it("uses Electron's placeholders for a conversation and a new Chat", async () => {
    const view = render(<ChatApp {...base} messages={conversation} />);
    expect(await screen.findByRole("textbox", { name: "Message chat" })).toHaveAttribute("placeholder", "Reply to chat…");
    view.unmount();
    render(<ChatApp {...base} sessionId={undefined} messages={[]} />);
    expect(await screen.findByRole("textbox", { name: "Message chat" })).toHaveAttribute("placeholder", "How can I help you today?");
  });

  it("shows Electron's new-Chat screen and fills the draft from a starter card", async () => {
    render(<ChatApp {...base} sessionId={undefined} messages={[]} />);
    expect(await screen.findByRole("heading", { name: "What should we build today?" })).toBeInTheDocument();
    expect(screen.queryByText("What should Matrix do?")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Build a new feature, app, or tool" }));
    expect(screen.getByRole("textbox", { name: "Message chat" })).toHaveValue("Build a new feature, app, or tool");
  });

  it("keeps the composer in Electron's 808px column for new and existing Chats", async () => {
    const view = render(<ChatApp {...base} sessionId={undefined} messages={[]} />);
    expect(toolbar().closest(".max-w-\\[808px\\]")).not.toBeNull();
    view.unmount();
    render(<ChatApp {...base} messages={conversation} />);
    await screen.findByRole("textbox", { name: "Message chat" });
    expect(toolbar().closest(".max-w-\\[808px\\]")).not.toBeNull();
  });

  it("grows the draft up to Electron's 220px cap and then scrolls", async () => {
    render(<ChatApp {...base} messages={conversation} />);
    const editor = await screen.findByRole("textbox", { name: "Message chat" });
    const height = vi.spyOn(HTMLTextAreaElement.prototype, "scrollHeight", "get").mockReturnValue(120);
    fireEvent.change(editor, { target: { value: "one\ntwo\nthree" } });
    expect(editor.style.height).toBe("120px");
    expect(editor.style.overflowY).toBe("hidden");
    height.mockReturnValue(400);
    fireEvent.change(editor, { target: { value: "long\n".repeat(30) } });
    expect(editor.style.height).toBe("220px");
    expect(editor.style.overflowY).toBe("auto");
    height.mockRestore();
  });

  it("shows Stop in the toolbar while a run is active", async () => {
    const onAbortCurrent = vi.fn();
    render(<ChatApp {...base} messages={conversation} busy activeRunId="run_composer" onAbortCurrent={onAbortCurrent} />);
    const bar = within(toolbar());
    fireEvent.click(await bar.findByRole("button", { name: "Stop" }));
    expect(onAbortCurrent).toHaveBeenCalledTimes(1);
    expect(bar.queryByRole("button", { name: "Send" })).toBeNull();
  });

  it("attaches queued messages above the composer with Steer, delete and a menu", async () => {
    const onSteer = vi.fn(async () => true);
    const onCancel = vi.fn(async () => true);
    render(<ChatApp {...base} messages={conversation} busy activeRunId="run_composer" onAbortCurrent={vi.fn()}
      queuedTurns={[queued]} canSteerQueuedTurns onSteerQueuedTurn={onSteer} onCancelQueuedTurn={onCancel} />);

    const queue = await screen.findByRole("region", { name: "Queued turns" });
    expect(queue.compareDocumentPosition(toolbar()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(queue).getByRole("button", { name: "More actions for Then summarize it" })).toBeInTheDocument();
    expect(within(queue).queryByRole("button", { name: /Reorder/ })).toBeNull();

    fireEvent.click(within(queue).getByRole("button", { name: "Steer Then summarize it" }));
    await waitFor(() => expect(onSteer).toHaveBeenCalledWith("cqturn_next"));
    fireEvent.click(within(queue).getByRole("button", { name: "Cancel Then summarize it" }));
    await waitFor(() => expect(onCancel).toHaveBeenCalledWith("cqturn_next"));
  });

  it("uses Electron's header: the Chat title on the left, with no model name or bot badge", async () => {
    const view = render(<ChatApp {...base} messages={conversation} activeConversationTitle="Review code and suggest changes" />);
    const header = document.querySelector<HTMLElement>('[data-slot="chat-session-header"]')!;
    const title = await within(header).findByRole("button", { name: "Rename Review code and suggest changes" });
    expect(title).toHaveClass("text-[15px]", "font-medium", "text-left");
    expect(header).not.toHaveClass("border-b");
    expect(header.querySelector('[data-slot="chat-header-badge"]')).toBeNull();
    await waitFor(() => expect(within(toolbar()).getByRole("button", { name: "Choose model and provider" })).toHaveTextContent("Claude Sonnet 5"));
    expect(within(header).queryByText("Claude Sonnet 5")).toBeNull();
    view.unmount();

    render(<ChatApp {...base} sessionId={undefined} messages={[]} />);
    const draftHeader = document.querySelector<HTMLElement>('[data-slot="chat-session-header"]')!;
    expect(draftHeader).toHaveTextContent("");
  });

  it("keeps the sidebar toggle at the top-left of the Chat pane, like Electron Desktop", () => {
    render(<ChatApp {...base} messages={conversation} />);
    const header = document.querySelector<HTMLElement>('[data-slot="chat-session-header"]')!;
    const sidebar = document.querySelector<HTMLElement>("aside[data-rail-order-root]")!;
    expect(within(sidebar).queryByRole("button", { name: "Close Chat sidebar" })).toBeNull();
    fireEvent.click(within(header).getByRole("button", { name: "Close Chat sidebar" }));
    expect(sidebar.className).toContain("w-0");
    fireEvent.click(within(header).getByRole("button", { name: "Open Chat sidebar" }));
    expect(sidebar.className).toContain("w-[260px]");
  });

  it("renders Chat text antialiased like Electron Desktop", () => {
    const { container } = render(<ChatApp {...base} messages={conversation} />);
    expect(container.firstElementChild).toHaveClass("antialiased");
  });

  it("puts a new Chat in a project from the composer folder button", async () => {
    webProjects.projects = [{ id: "proj_second", slug: "second", name: "second", kind: "scratch" }, { id: "proj_first", slug: "first", name: "first", kind: "scratch" }];
    const onSetChatProject = vi.fn();
    const view = render(<ChatApp {...base} sessionId={undefined} messages={[]} onSetChatProject={onSetChatProject} />);
    fireEvent.click(within(toolbar()).getByRole("button", { name: "Add to project" }));
    fireEvent.click(await screen.findByRole("option", { name: "first, Scratch" }));
    expect(onSetChatProject).toHaveBeenCalledWith("proj_first");

    view.rerender(<ChatApp {...base} sessionId={undefined} messages={[]} chatProjectId="proj_first" onSetChatProject={onSetChatProject} />);
    fireEvent.click(within(toolbar()).getByRole("button", { name: "Project first" }));
    fireEvent.click(await screen.findByRole("button", { name: "Remove project context" }));
    expect(onSetChatProject).toHaveBeenLastCalledWith(null);
  });

  it("marks a Chat's missing project as unavailable and hides the picker without a handler", async () => {
    const view = render(<ChatApp {...base} messages={conversation} chatProjectId="proj_gone" onSetChatProject={vi.fn()} />);
    expect(within(toolbar()).getByRole("button", { name: "Project proj_gone, unavailable" })).toBeInTheDocument();
    view.rerender(<ChatApp {...base} messages={conversation} />);
    expect(within(toolbar()).queryByRole("button", { name: /project/i })).toBeNull();
  });

  it("wires the project picker in Web Desktop, Web Canvas and Web Mobile", () => {
    for (const [file, state] of [["desktop/DesktopWindow.tsx", "chat"], ["canvas/CanvasWindow.tsx", "chatState"], ["mobile/MobileShell.tsx", "chat"]] as const) {
      const source = readFileSync(path.resolve(import.meta.dirname, "../../shell/src/components", file), "utf8");
      expect(source, file).toContain(`chatProjectId={${state}.chatProjectId} onSetChatProject={${state}.setChatProject}`);
    }
  });

  it("disables Steer when the active run cannot take same-run steering", async () => {
    render(<ChatApp {...base} messages={conversation} busy activeRunId="run_composer" onAbortCurrent={vi.fn()}
      queuedTurns={[queued]} onSteerQueuedTurn={vi.fn()} onCancelQueuedTurn={vi.fn()} />);
    expect(await screen.findByRole("button", { name: "Steer Then summarize it" })).toBeDisabled();
  });
});
