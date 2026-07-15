// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { wireKernel } from "../../desktop/src/renderer/src/lib/kernel-wiring";
import { useCodingAgentWorkspace } from "../../desktop/src/renderer/src/stores/coding-agent-workspace";
import { useConnection } from "../../desktop/src/renderer/src/stores/connection";
import { useTabs } from "../../desktop/src/renderer/src/stores/tabs";
import { useThreads } from "../../desktop/src/renderer/src/stores/threads";

type MockKernelSocket = {
  subscribe: ReturnType<typeof vi.fn>;
  connect: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
};

function codingAgentAttentionSummaryFixture() {
  return {
    runtime: { id: "rt_primary", label: "Primary", status: "available" },
    capabilities: [],
    providers: [],
    projects: { items: [], hasMore: false, limit: 20 },
    activeThreads: { items: [], hasMore: false, limit: 20 },
    attentionThreads: {
      items: [
        {
          id: "thread_approval",
          providerId: "codex",
          title: "Approve deployment",
          status: "waiting_for_approval",
          attention: "approval_required",
          createdAt: "2026-07-06T00:00:00.000Z",
          updatedAt: "2026-07-06T00:01:00.000Z",
        },
        {
          id: "thread_failed",
          providerId: "codex",
          title: "Repair failed run",
          status: "failed",
          attention: "failed",
          createdAt: "2026-07-06T00:00:00.000Z",
          updatedAt: "2026-07-06T00:02:00.000Z",
        },
      ],
      hasMore: false,
      limit: 20,
    },
    terminalSessions: { items: [], hasMore: false, limit: 20 },
    recentActivity: { items: [], hasMore: false, limit: 20 },
    limits: {
      maxPromptBytes: 16384,
      maxAttachmentCount: 8,
      maxTerminalInputBytes: 8192,
      maxListItems: 20,
    },
    serverTime: "2026-07-06T00:03:00.000Z",
  };
}

const kernelSocketMocks = vi.hoisted(() => ({
  instances: [] as MockKernelSocket[],
}));

vi.mock("../../desktop/src/renderer/src/lib/kernel-socket", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../desktop/src/renderer/src/lib/kernel-socket")>();
  return {
    ...actual,
    KernelSocket: vi.fn().mockImplementation(function MockKernelSocketConstructor() {
      const instance: MockKernelSocket = {
        subscribe: vi.fn(() => () => undefined),
        connect: vi.fn(),
        dispose: vi.fn(),
      };
      kernelSocketMocks.instances.push(instance);
      return instance;
    }),
  };
});

describe("kernel wiring", () => {
  let notificationClick: ((payload: { threadId: string }) => void) | null = null;

  beforeEach(() => {
    notificationClick = null;
    kernelSocketMocks.instances.length = 0;
    useConnection.setState({
      status: "signed-in",
      handle: "operator",
      platformHost: "https://platform.test",
      runtimeSlot: "primary",
      api: null,
    });
    useTabs.setState({ tabs: [], activeTabId: null });
    useThreads.setState({ threads: [], activeThreadId: null });
    useCodingAgentWorkspace.setState({
      status: "idle",
      summary: null,
      error: null,
      reviewsStatus: "idle",
      reviews: null,
      reviewsError: null,
      selectedReviewId: null,
      reviewSnapshotStatus: "idle",
      reviewSnapshot: null,
      reviewSnapshotError: null,
      createStatus: "idle",
      createError: null,
      activeThreadId: null,
    });
    window.operator = {
      invoke: vi.fn().mockResolvedValue(undefined),
      on: vi.fn((channel: string, callback: (payload: unknown) => void) => {
        if (channel === "notification:clicked") {
          notificationClick = callback as (payload: { threadId: string }) => void;
        }
        return () => undefined;
      }),
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("focuses the coding-agent workspace thread when a native notification is clicked", () => {
    const loadThreadSnapshot = vi.fn().mockResolvedValue(undefined);
    useCodingAgentWorkspace.setState({ loadThreadSnapshot });
    const cleanup = wireKernel();

    expect(notificationClick).not.toBeNull();
    notificationClick?.({ threadId: "thread_alpha" });

    expect(loadThreadSnapshot).toHaveBeenCalledWith("thread_alpha");
    const tabs = useTabs.getState();
    expect(tabs.tabs.find((tab) => tab.id === tabs.activeTabId)?.kind).toBe("agents");

    cleanup();
  });

  it("routes a kernel-thread notification to the chat tab without touching the coding-agent store", () => {
    const loadThreadSnapshot = vi.fn().mockResolvedValue(undefined);
    useCodingAgentWorkspace.setState({ loadThreadSnapshot });
    useThreads.setState({
      threads: [
        {
          id: "thread-1000-1",
          requestId: "request-1",
          sessionId: null,
          taskId: null,
          title: "Kernel run",
          status: "done",
          transcript: [],
          unread: true,
          createdAt: 1_000,
          updatedAt: 1_000,
        },
      ],
      activeThreadId: null,
    });
    const cleanup = wireKernel();

    notificationClick?.({ threadId: "thread-1000-1" });

    expect(useThreads.getState().activeThreadId).toBe("thread-1000-1");
    expect(loadThreadSnapshot).not.toHaveBeenCalled();
    expect(useCodingAgentWorkspace.getState().activeThreadId).toBeNull();
    const tabs = useTabs.getState();
    expect(tabs.tabs.find((tab) => tab.id === tabs.activeTabId)?.kind).toBe("chat");

    cleanup();
  });

  it("routes a stale kernel-format notification to the chat tab with no selection", () => {
    const loadThreadSnapshot = vi.fn().mockResolvedValue(undefined);
    useCodingAgentWorkspace.setState({ loadThreadSnapshot });
    const cleanup = wireKernel();

    notificationClick?.({ threadId: "thread-999-9" });

    expect(useThreads.getState().activeThreadId).toBeNull();
    expect(loadThreadSnapshot).not.toHaveBeenCalled();
    const tabs = useTabs.getState();
    expect(tabs.tabs.find((tab) => tab.id === tabs.activeTabId)?.kind).toBe("chat");

    cleanup();
  });

  it("treats the selected kernel thread as focused while the chat tab is active", () => {
    useThreads.setState({
      threads: [
        {
          id: "thread-1000-1",
          requestId: "request-1",
          sessionId: null,
          taskId: null,
          title: "Kernel run",
          status: "running",
          transcript: [],
          unread: false,
          createdAt: 1_000,
          updatedAt: 1_000,
        },
      ],
      activeThreadId: "thread-1000-1",
    });
    useTabs.getState().openTab({ kind: "chat", title: "Hermes", closable: false });
    const cleanup = wireKernel();
    const invoke = window.operator.invoke as ReturnType<typeof vi.fn>;
    invoke.mockClear();
    const handleMessage = kernelSocketMocks.instances[0]?.subscribe.mock.calls[0]?.[0] as (
      msg: unknown,
    ) => void;

    handleMessage({ type: "kernel:result", data: {}, requestId: "request-1" });

    const updated = useThreads.getState().threads[0];
    expect(updated?.status).toBe("done");
    expect(updated?.unread).toBe(false);
    expect(invoke).not.toHaveBeenCalledWith("notify", expect.anything());

    cleanup();
  });

  it("marks the selected kernel thread unread and notifies when another tab is active", () => {
    useThreads.setState({
      threads: [
        {
          id: "thread-1000-1",
          requestId: "request-1",
          sessionId: null,
          taskId: null,
          title: "Kernel run",
          status: "running",
          transcript: [],
          unread: false,
          createdAt: 1_000,
          updatedAt: 1_000,
        },
      ],
      activeThreadId: "thread-1000-1",
    });
    useTabs.getState().openTab({ kind: "home", title: "Home", closable: false });
    const cleanup = wireKernel();
    const invoke = window.operator.invoke as ReturnType<typeof vi.fn>;
    invoke.mockClear();
    const handleMessage = kernelSocketMocks.instances[0]?.subscribe.mock.calls[0]?.[0] as (
      msg: unknown,
    ) => void;

    handleMessage({ type: "kernel:result", data: {}, requestId: "request-1" });

    const updated = useThreads.getState().threads[0];
    expect(updated?.status).toBe("done");
    expect(updated?.unread).toBe(true);
    expect(invoke).toHaveBeenCalledWith("notify", expect.objectContaining({ threadId: "thread-1000-1", kind: "done" }));

    cleanup();
  });

  it("includes gateway-owned coding-agent attention in the desktop badge count", () => {
    const cleanup = wireKernel();
    const invoke = window.operator.invoke as ReturnType<typeof vi.fn>;

    useCodingAgentWorkspace.setState({
      summary: codingAgentAttentionSummaryFixture(),
    });

    expect(invoke).toHaveBeenLastCalledWith("badge:set", { count: 2 });

    useCodingAgentWorkspace.setState({
      summary: {
        ...codingAgentAttentionSummaryFixture(),
        attentionThreads: { items: [], hasMore: false, limit: 20 },
      },
    });

    expect(invoke).toHaveBeenLastCalledWith("badge:set", { count: 0 });

    cleanup();
  });

  it("uses the desktop badge cap for truncated coding-agent attention summaries", () => {
    const cleanup = wireKernel();
    const invoke = window.operator.invoke as ReturnType<typeof vi.fn>;
    const summary = codingAgentAttentionSummaryFixture();

    useCodingAgentWorkspace.setState({
      summary: {
        ...summary,
        attentionThreads: {
          ...summary.attentionThreads,
          hasMore: true,
        },
      },
    });

    expect(invoke).toHaveBeenLastCalledWith("badge:set", { count: 999 });

    cleanup();
  });
});
