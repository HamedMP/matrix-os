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

const kernelSocketMocks = vi.hoisted(() => ({
  instances: [] as MockKernelSocket[],
}));

vi.mock("../../desktop/src/renderer/src/lib/kernel-socket", () => ({
  KernelSocket: vi.fn().mockImplementation(function MockKernelSocketConstructor() {
    const instance: MockKernelSocket = {
      subscribe: vi.fn(() => () => undefined),
      connect: vi.fn(),
      dispose: vi.fn(),
    };
    kernelSocketMocks.instances.push(instance);
    return instance;
  }),
}));

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
    const cleanup = wireKernel();

    expect(notificationClick).not.toBeNull();
    notificationClick?.({ threadId: "thread_alpha" });

    expect(useCodingAgentWorkspace.getState().activeThreadId).toBe("thread_alpha");
    const tabs = useTabs.getState();
    expect(tabs.tabs.find((tab) => tab.id === tabs.activeTabId)?.kind).toBe("agents");

    cleanup();
  });
});
