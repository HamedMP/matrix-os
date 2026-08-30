// @vitest-environment jsdom

import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { CanonicalChatDetailResponse, RuntimeSummary, TerminalSessionSummary } from "@matrix-os/contracts";
import { WorkFilesInspector } from "@desktop/renderer/src/features/work/WorkFilesInspector";
import type { Project } from "@desktop/renderer/src/stores/board";
import { useCodingAgentWorkspace } from "@desktop/renderer/src/stores/coding-agent-workspace";
import { useConnection } from "@desktop/renderer/src/stores/connection";
import { createCanonicalChatFixture } from "../contracts/fixtures/canonical-chat";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const resizeObserverCallbacks: ResizeObserverCallback[] = [];

class NoopResizeObserver implements ResizeObserver {
  constructor(callback: ResizeObserverCallback) { resizeObserverCallbacks.push(callback); }
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() { return []; }
}

const terminalViewMock = vi.hoisted(() => ({
  props: [] as Array<{ sessionName: string; chatId?: string; active?: boolean }>,
}));

vi.mock("@desktop/renderer/src/features/terminal/TerminalView", () => ({
  default: (props: { sessionName: string; chatId?: string; active?: boolean }) => {
    terminalViewMock.props.push(props);
    return <div data-testid="work-terminal" data-session={props.sessionName} data-chat={props.chatId} data-active={String(props.active)} />;
  },
}));

const NOW = "2026-08-28T10:00:00.000Z";
const { snapshot } = createCanonicalChatFixture("completed");
const WORKSPACE_ID = `tws_${"a".repeat(32)}`;

function refKey(label: string): string {
  const value = [...label].reduce((sum, char) => (sum * 31 + char.charCodeAt(0)) >>> 0, 0);
  return `${WORKSPACE_ID}:tt_${value.toString(16).padStart(32, "0")}`;
}

function terminal(id: string): TerminalSessionSummary {
  return { id, name: id, status: "running", attachable: true, createdAt: NOW, updatedAt: NOW };
}

function summary(items: TerminalSessionSummary[]): RuntimeSummary {
  return {
    runtime: { id: "rt_primary", label: "Primary", status: "available" },
    capabilities: [], providers: [],
    projects: { items: [], hasMore: false, limit: 20 },
    activeThreads: { items: [], hasMore: false, limit: 20 },
    attentionThreads: { items: [], hasMore: false, limit: 20 },
    terminalWorkspaces: {
      items: [{
        id: WORKSPACE_ID,
        scope: "main",
        name: "Main",
        revision: 1,
        createdAt: NOW,
        updatedAt: NOW,
        tabs: items.map((item, order) => ({
          id: refKey(item.id).split(":")[1]!,
          workspaceId: WORKSPACE_ID,
          name: item.name,
          cwd: "",
          status: item.status === "stale" ? "unavailable" : item.status,
          revision: 1,
          order,
          createdAt: item.createdAt,
          updatedAt: item.updatedAt,
        })),
      }],
      hasMore: false,
      limit: 50,
    },
    previewSessions: { items: [], hasMore: false, limit: 50 },
    recentActivity: { items: [], hasMore: false, limit: 20 },
    limits: { maxPromptBytes: 16_384, maxAttachmentCount: 8, maxTerminalInputBytes: 8_192, maxListItems: 20 },
    serverTime: NOW,
  };
}

function detail(chatId: string, sessionId?: string): CanonicalChatDetailResponse {
  const run = { ...snapshot.runs[0]!, id: `run_${chatId}`, chatId };
  return {
    record: { ...snapshot, chat: { ...snapshot.chat, id: chatId } },
    messages: [], turns: [], runs: [run],
    activities: sessionId ? [{
      id: `activity_${chatId}`,
      chatId,
      runId: run.id,
      occurredAt: NOW,
      type: "terminal.bound",
      terminalSessionId: refKey(sessionId),
    }] : [],
  };
}

function projectDetail(chatId: string, sessionId?: string): {
  chatDetail: CanonicalChatDetailResponse;
  project: Project;
} {
  const project: Project = { id: "project_stable", slug: "matrix-os", name: "Matrix OS", kind: "github" };
  const chatDetail = detail(chatId, sessionId);
  chatDetail.record = { ...chatDetail.record, projectId: project.id };
  chatDetail.runs = chatDetail.runs.map((run) => ({
    ...run,
    executionRoot: { kind: "project" as const, projectId: project.id },
  }));
  return { chatDetail, project };
}

describe("Work Files and Terminal inspector", () => {
  beforeAll(() => { globalThis.ResizeObserver = NoopResizeObserver; });
  beforeEach(() => {
    resizeObserverCallbacks.length = 0;
    terminalViewMock.props = [];
    useConnection.setState({
      ...useConnection.getInitialState(),
      status: "signed-in",
      runtimeSlot: "primary",
      authGeneration: 1,
      api: {
        baseUrl: "https://matrix.test",
        post: vi.fn(async (path: string, body: { name?: string }) => path.endsWith("/ensure")
          ? { workspace: { id: WORKSPACE_ID } }
          : {
              tab: {
                id: refKey(body.name ?? "Chat terminal").split(":")[1],
                name: body.name ?? "Chat terminal",
                status: "running",
                createdAt: NOW,
                updatedAt: NOW,
              },
            }),
        delete: vi.fn(async () => ({})),
      } as never,
    }, true);
    useCodingAgentWorkspace.setState({
      ...useCodingAgentWorkspace.getInitialState(),
      status: "ready",
      summary: summary([terminal("terminal_first"), terminal("terminal_second"), terminal("terminal_unrelated")]),
      refresh: vi.fn(async () => undefined),
    }, true);
    Object.defineProperty(window, "operator", {
      configurable: true,
      value: { invoke: vi.fn(async (channel: string, request?: unknown) => {
        if (channel === "runtime:browse-files") {
          return {
            directory: { kind: "directory" },
            entries: { items: [{ path: "README.md", kind: "file", sizeBytes: 6 }] },
          };
        }
        if (channel === "runtime:get-file-content") {
          const path = (request as { path: string }).path;
          return {
            metadata: { path, kind: "file", sizeBytes: 6, etag: "etag_readme", updatedAt: NOW },
            content: "README",
            encoding: "utf8",
            truncated: false,
            limitBytes: 65_536,
          };
        }
        return { ok: true };
      }), on: vi.fn(() => () => undefined) },
    });
  });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("uses addable tabs without a Conversation tools header", () => {
    render(<WorkFilesInspector detail={detail("chat_first", "terminal_first")} projects={[]} active />);

    const inspector = screen.getByRole("complementary", { name: "Chat inspector" });
    expect(inspector.classList.contains("border-l")).toBe(true);
    expect(screen.queryByText("Conversation tools")).toBeNull();
    expect(screen.getByRole("tab", { name: "Files" }).getAttribute("aria-selected")).toBe("true");

    fireEvent.pointerDown(screen.getByRole("button", { name: "Add inspector tab" }), { button: 0, ctrlKey: false });
    fireEvent.click(screen.getByRole("menuitem", { name: "Open terminal terminal_first" }));

    expect(screen.getByRole("tab", { name: "terminal_first" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByTestId("work-terminal").getAttribute("data-active")).toBe("true");
  });

  it("creates and immediately opens a new Chat-bound terminal", async () => {
    render(<WorkFilesInspector detail={detail("chat_fresh")} projects={[]} active />);

    fireEvent.pointerDown(screen.getByRole("button", { name: "Add inspector tab" }), { button: 0, ctrlKey: false });
    fireEvent.click(screen.getByRole("menuitem", { name: "New terminal" }));

    await waitFor(() => expect(useConnection.getState().api?.post).toHaveBeenCalledWith(
      `/api/terminal/workspaces/${WORKSPACE_ID}/tabs`,
      expect.objectContaining({ chatId: "chat_fresh", name: "Chat terminal" }),
    ));
    expect((await screen.findByTestId("work-terminal")).getAttribute("data-chat")).toBe("chat_fresh");
  });

  it("creates a Chat identity before opening a terminal from New Chat", async () => {
    const resolveDraftChatId = vi.fn(async () => "chat_from_draft");
    const onDraftTerminalCreated = vi.fn();
    render(
      <WorkFilesInspector
        scope={{ kind: "home", chatId: "draft:global" }}
        projects={[]}
        active
        resolveDraftChatId={resolveDraftChatId}
        onDraftTerminalCreated={onDraftTerminalCreated}
      />,
    );

    fireEvent.pointerDown(screen.getByRole("button", { name: "Add inspector tab" }), { button: 0, ctrlKey: false });
    fireEvent.click(screen.getByRole("menuitem", { name: "New terminal" }));

    await waitFor(() => expect(resolveDraftChatId).toHaveBeenCalledOnce());
    await waitFor(() => expect(useConnection.getState().api?.post).toHaveBeenCalledWith(
      `/api/terminal/workspaces/${WORKSPACE_ID}/tabs`,
      expect.objectContaining({ chatId: "chat_from_draft", name: "Chat terminal" }),
    ));
    expect((await screen.findByTestId("work-terminal")).getAttribute("data-chat")).toBe("chat_from_draft");
    expect(onDraftTerminalCreated).toHaveBeenCalledWith(
      "chat_from_draft",
      expect.objectContaining({ id: expect.stringMatching(/^tws_.+:tt_.+$/) }),
    );
  });

  it("keeps multiple chat-bound terminal tabs while activating only the selected one", () => {
    const chatDetail = detail("chat_multi", "terminal_first");
    chatDetail.activities.push({
      id: "activity_terminal_second",
      chatId: "chat_multi",
      runId: chatDetail.runs[0]!.id,
      occurredAt: NOW,
      type: "terminal.bound",
      terminalSessionId: refKey("terminal_second"),
    });
    render(<WorkFilesInspector detail={chatDetail} projects={[]} active />);

    fireEvent.pointerDown(screen.getByRole("button", { name: "Add inspector tab" }), { button: 0, ctrlKey: false });
    fireEvent.click(screen.getByRole("menuitem", { name: "Open terminal terminal_first" }));
    fireEvent.pointerDown(screen.getByRole("button", { name: "Add inspector tab" }), { button: 0, ctrlKey: false });
    fireEvent.click(screen.getByRole("menuitem", { name: "Open terminal terminal_second" }));

    expect(screen.getByRole("tab", { name: "terminal_first" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "terminal_second" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getAllByTestId("work-terminal").map((node) => node.getAttribute("data-active"))).toEqual(["false", "true"]);

    fireEvent.click(screen.getByRole("tab", { name: "terminal_first" }));
    expect(screen.getAllByTestId("work-terminal").map((node) => node.getAttribute("data-active"))).toEqual(["true", "false"]);
  });

  it("ends a terminal session before removing its tab", async () => {
    render(<WorkFilesInspector detail={detail("chat_first", "terminal_first")} projects={[]} active />);
    fireEvent.pointerDown(screen.getByRole("button", { name: "Add inspector tab" }), { button: 0, ctrlKey: false });
    fireEvent.click(screen.getByRole("menuitem", { name: "Open terminal terminal_first" }));

    fireEvent.click(screen.getByRole("button", { name: "Close terminal_first tab" }));

    await waitFor(() => expect(useConnection.getState().api?.delete).toHaveBeenCalledWith(
      `/api/terminal/workspaces/${WORKSPACE_ID}/tabs/${refKey("terminal_first").split(":")[1]}`,
    ));
    await waitFor(() => expect(screen.queryByRole("tab", { name: "terminal_first" })).toBeNull());
  });

  it("shows the file list alone until a preview opens and hides it for Terminal", async () => {
    render(<WorkFilesInspector detail={detail("chat_first", "terminal_first")} projects={[]} active />);

    expect(screen.getByRole("region", { name: "Files" })).toBeTruthy();
    expect(screen.queryByRole("separator", { name: "Resize file list" })).toBeNull();

    fireEvent.pointerDown(screen.getByRole("button", { name: "Add inspector tab" }), { button: 0, ctrlKey: false });
    fireEvent.click(screen.getByRole("menuitem", { name: "Open terminal terminal_first" }));

    expect(screen.queryByRole("region", { name: "Files" })).toBeNull();
    expect(screen.queryByRole("separator", { name: "Resize file list" })).toBeNull();
    expect(screen.getByTestId("work-terminal").getAttribute("data-active")).toBe("true");

    fireEvent.click(screen.getByRole("tab", { name: "Files" }));
    expect(await screen.findByRole("region", { name: "Files" })).toBeTruthy();
    expect(screen.queryByRole("separator", { name: "Resize file list" })).toBeNull();
  });

  it("resizes the file list beside an open preview with an accessible divider", async () => {
    const { chatDetail, project } = projectDetail("chat_first");
    const { container } = render(<WorkFilesInspector detail={chatDetail} projects={[project]} active />);

    fireEvent.click(await screen.findByRole("button", { name: "Open file README.md" }));
    await screen.findByText("README");

    const panes = container.querySelector('[data-layout="split"]');
    expect(panes?.children[0]?.getAttribute("aria-label")).toBe("Files");
    expect(panes?.children[2]?.querySelector('[aria-label="File preview"]')).not.toBeNull();
    const divider = screen.getByRole("separator", { name: "Resize file list" });
    expect(divider.getAttribute("aria-valuenow")).toBe("300");
    fireEvent.keyDown(divider, { key: "ArrowRight" });
    expect(screen.getByRole("separator", { name: "Resize file list" }).getAttribute("aria-valuenow")).toBe("316");
  });

  it("keeps a usable preview when the inspector becomes narrower", async () => {
    const { chatDetail, project } = projectDetail("chat_first");
    render(<WorkFilesInspector detail={chatDetail} projects={[project]} active />);

    fireEvent.click(await screen.findByRole("button", { name: "Open file README.md" }));
    await screen.findByText("README");

    const callback = resizeObserverCallbacks.at(-1);
    expect(callback).toBeTypeOf("function");
    act(() => callback?.([{
      contentRect: { width: 480 },
    } as unknown as ResizeObserverEntry], {} as ResizeObserver));

    expect(screen.getByRole("separator", { name: "Resize file list" }).getAttribute("aria-valuenow")).toBe("232");
  });

  it("keeps one permanent Files tab and reselects it from the add menu", () => {
    render(<WorkFilesInspector detail={detail("chat_reopen", "terminal_first")} projects={[]} active />);

    fireEvent.pointerDown(screen.getByRole("button", { name: "Add inspector tab" }), { button: 0, ctrlKey: false });
    fireEvent.click(screen.getByRole("menuitem", { name: "Open terminal terminal_first" }));
    expect(screen.queryByRole("button", { name: "Close Files tab" })).toBeNull();

    fireEvent.pointerDown(screen.getByRole("button", { name: "Add inspector tab" }), { button: 0, ctrlKey: false });
    fireEvent.click(screen.getByRole("menuitem", { name: "Files" }));

    expect(screen.getAllByRole("tab", { name: "Files" })).toHaveLength(1);
    expect(screen.getByRole("tab", { name: "Files" }).getAttribute("aria-selected")).toBe("true");
  });

  it("previews Project files in one Files tab beside an expandable folder tree", async () => {
    const project: Project = { id: "project_stable", slug: "matrix-os", name: "Matrix OS", kind: "github" };
    const chatDetail = detail("chat_project");
    chatDetail.record = { ...chatDetail.record, projectId: project.id };
    chatDetail.runs = chatDetail.runs.map((run) => ({
      ...run,
      executionRoot: { kind: "worktree" as const, projectId: project.id, worktreeId: "wt_owned" },
    }));
    window.operator.invoke = vi.fn(async (channel: string, request?: unknown) => {
      if (channel === "runtime:browse-files") {
        const path = (request as { path?: string } | undefined)?.path;
        return {
          directory: { kind: "directory", ...(path ? { path } : {}) },
          entries: { items: path === "src" ? [
            { path: "src/alpha.txt", kind: "file", sizeBytes: 5 },
            { path: "src/beta.txt", kind: "file", sizeBytes: 4 },
          ] : [{ path: "src", kind: "directory" }] },
        };
      }
      if (channel === "runtime:get-file-content") {
        const path = (request as { path: string }).path;
        return {
          metadata: { path, kind: "file", sizeBytes: path.length, etag: `etag_${path}`, updatedAt: NOW },
          content: path === "src/alpha.txt" ? "alpha" : "beta",
          encoding: "utf8",
          truncated: false,
          limitBytes: 65_536,
        };
      }
      return { ok: true };
    }) as typeof window.operator.invoke;

    const { container } = render(<WorkFilesInspector detail={chatDetail} projects={[project]} active />);
    expect(container.querySelector('[data-layout="files-only"]')).not.toBeNull();
    expect(screen.getByRole("region", { name: "Files" })).toBeTruthy();

    const folder = await screen.findByRole("button", { name: "Expand folder src" });
    fireEvent.click(folder);
    fireEvent.click(await screen.findByRole("button", { name: "Open file src/alpha.txt" }));
    expect(container.querySelector('[data-layout="split"]')).not.toBeNull();
    expect(await screen.findByText("alpha")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open file src/beta.txt" }));
    expect(await screen.findByText("beta")).toBeTruthy();

    expect(folder.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getAllByRole("tab", { name: "Files" })).toHaveLength(1);
    expect(screen.queryByRole("tab", { name: "alpha.txt" })).toBeNull();
    expect(screen.queryByRole("tab", { name: "beta.txt" })).toBeNull();
  });

  it("offers only the selected Chat binding and releases it when a file tab is selected", () => {
    render(<WorkFilesInspector detail={detail("chat_first", "terminal_first")} projects={[]} active />);

    fireEvent.pointerDown(screen.getByRole("button", { name: "Add inspector tab" }), { button: 0, ctrlKey: false });
    expect(screen.getByRole("menuitem", { name: "Open terminal terminal_first" })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: "Open terminal terminal_unrelated" })).toBeNull();
    fireEvent.click(screen.getByRole("menuitem", { name: "Open terminal terminal_first" }));

    expect(screen.getByTestId("work-terminal").getAttribute("data-chat")).toBe("chat_first");
    expect(screen.getByTestId("work-terminal").getAttribute("data-active")).toBe("true");

    fireEvent.click(screen.getByRole("tab", { name: "Files" }));
    expect(terminalViewMock.props.at(-1)?.active).toBe(false);
  });

  it("exposes a labeled close control for responsive Work layouts", () => {
    const onClose = vi.fn();
    render(
      <WorkFilesInspector
        detail={detail("chat_first")}
        projects={[]}
        active
        onClose={onClose}
        closeLabel="Back to chat"
      />,
    );

    const close = screen.getByRole("button", { name: "Back to chat" });
    close.focus();
    expect(document.activeElement).toBe(close);
    fireEvent.click(close);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("deactivates and resets the embedded terminal when Work or the selected Chat changes", () => {
    const view = render(<WorkFilesInspector detail={detail("chat_first", "terminal_first")} projects={[]} active />);
    fireEvent.pointerDown(screen.getByRole("button", { name: "Add inspector tab" }), { button: 0, ctrlKey: false });
    fireEvent.click(screen.getByRole("menuitem", { name: "Open terminal terminal_first" }));

    view.rerender(<WorkFilesInspector detail={detail("chat_first", "terminal_first")} projects={[]} active={false} />);
    expect(terminalViewMock.props.at(-1)?.active).toBe(false);

    view.rerender(<WorkFilesInspector detail={detail("chat_second", "terminal_second")} projects={[]} active />);
    expect(screen.queryByTestId("work-terminal")).toBeNull();
    expect(screen.getByRole("tab", { name: "Files" }).getAttribute("aria-selected")).toBe("true");
    fireEvent.pointerDown(screen.getByRole("button", { name: "Add inspector tab" }), { button: 0, ctrlKey: false });
    expect(screen.getByRole("menuitem", { name: "Open terminal terminal_second" })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: "Open terminal terminal_first" })).toBeNull();
  });

  it("refreshes a stale live registry when a new binding arrives on the open Terminal tab", async () => {
    let releaseBindingRefresh!: () => void;
    const bindingRefresh = new Promise<void>((resolve) => { releaseBindingRefresh = resolve; });
    const refresh = vi.fn(async () => {
      if (refresh.mock.calls.length !== 1) return;
      await bindingRefresh;
      useCodingAgentWorkspace.setState({
        status: "ready",
        summary: summary([terminal("terminal_new")]),
      });
    });
    useCodingAgentWorkspace.setState({ status: "ready", summary: summary([terminal("terminal_first")]), refresh });
    const view = render(<WorkFilesInspector detail={detail("chat_live", "terminal_first")} projects={[]} active />);
    fireEvent.pointerDown(screen.getByRole("button", { name: "Add inspector tab" }), { button: 0, ctrlKey: false });
    fireEvent.click(screen.getByRole("menuitem", { name: "Open terminal terminal_first" }));
    expect(refresh).not.toHaveBeenCalled();

    view.rerender(<WorkFilesInspector detail={detail("chat_live", "terminal_new")} projects={[]} active />);
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));

    await act(async () => releaseBindingRefresh());
    fireEvent.pointerDown(screen.getByRole("button", { name: "Add inspector tab" }), { button: 0, ctrlKey: false });
    await waitFor(() => expect(screen.getByRole("menuitem", { name: "Open terminal terminal_new" })).toBeTruthy());
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("bounds live-registry retries and cancels them when the inspector unmounts", async () => {
    vi.useFakeTimers();
    try {
      const refresh = vi.fn(async () => undefined);
      useCodingAgentWorkspace.setState({ status: "ready", summary: summary([]), refresh });
      const view = render(
        <WorkFilesInspector detail={detail("chat_retry", "terminal_pending")} projects={[]} active />,
      );

      await act(async () => undefined);
      await act(async () => { await vi.runAllTimersAsync(); });

      expect(refresh).toHaveBeenCalledTimes(4);
      expect(vi.getTimerCount()).toBe(0);
      view.unmount();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
