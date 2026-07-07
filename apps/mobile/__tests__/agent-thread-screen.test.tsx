jest.mock("@/app/_layout", () => ({
  useGateway: jest.fn(),
}));

jest.mock("@react-native-async-storage/async-storage", () => ({
  getItem: jest.fn(),
  setItem: jest.fn(),
}));

const mockParams = { threadId: "thread_mobile" };
const mockRouterPush = jest.fn();

jest.mock("expo-router", () => ({
  useLocalSearchParams: () => mockParams,
  useRouter: () => ({ push: mockRouterPush }),
}));

import React from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import AgentThreadRoute from "../app/agents/[threadId]";
import { useGateway } from "@/app/_layout";
import { MOBILE_SHELL_STATE_STORAGE_KEY } from "../lib/mobile-shell-state";
import type { GatewayClient } from "../lib/gateway-client";

const useGatewayMock = useGateway as jest.MockedFunction<typeof useGateway>;
type GatewayContextValue = ReturnType<typeof useGateway>;

function gatewayContext(overrides: Partial<GatewayContextValue>): GatewayContextValue {
  return {
    client: null,
    connectionState: "disconnected",
    gateway: null,
    setGateway: jest.fn(),
    unreadCount: 0,
    incrementUnread: jest.fn(),
    clearUnread: jest.fn(),
    ...overrides,
  };
}

function threadSnapshotFixture() {
  return {
    thread: {
      id: "thread_mobile",
      providerId: "codex",
      title: "Repair mobile route",
      status: "running",
      attention: "none",
      terminalSessionId: "matrix-abc1234",
      createdAt: "2026-07-06T00:00:00.000Z",
      updatedAt: "2026-07-06T00:01:00.000Z",
    },
    events: {
      items: [
        {
          eventId: "evt_mobile_1",
          threadId: "thread_mobile",
          type: "thread.status",
          status: "running",
          occurredAt: "2026-07-06T00:01:00.000Z",
        },
        {
          eventId: "evt_mobile_2",
          threadId: "thread_mobile",
          type: "terminal.bound",
          terminalSessionId: "matrix-abc1234",
          occurredAt: "2026-07-06T00:01:30.000Z",
        },
      ],
      hasMore: false,
      limit: 200,
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

describe("AgentThreadRoute", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockParams.threadId = "thread_mobile";
    jest.mocked(AsyncStorage.getItem).mockResolvedValue(null);
    jest.mocked(AsyncStorage.setItem).mockResolvedValue();
  });

  it("hydrates a bounded coding-agent thread snapshot from the gateway", async () => {
    const client = {
      getCodingAgentThreadSnapshot: jest.fn().mockResolvedValue({
        ok: true,
        snapshot: threadSnapshotFixture(),
      }),
    };
    useGatewayMock.mockReturnValue(gatewayContext({
      client: client as unknown as GatewayClient,
      connectionState: "connected",
    }));

    render(<AgentThreadRoute />);

    expect(screen.getByText("Loading thread...")).toBeTruthy();
    expect(await screen.findByText("Repair mobile route")).toBeTruthy();
    expect(screen.getAllByText("running").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("codex")).toBeTruthy();
    expect(screen.getAllByText("matrix-abc1234").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("2 events")).toBeTruthy();
    expect(client.getCodingAgentThreadSnapshot).toHaveBeenCalledWith({ threadId: "thread_mobile" });
  });

  it("opens the bound terminal through the existing terminal tab and safe resume state", async () => {
    const client = {
      getCodingAgentThreadSnapshot: jest.fn().mockResolvedValue({
        ok: true,
        snapshot: threadSnapshotFixture(),
      }),
    };
    useGatewayMock.mockReturnValue(gatewayContext({
      client: client as unknown as GatewayClient,
      connectionState: "connected",
    }));

    render(<AgentThreadRoute />);

    expect(await screen.findByText("Repair mobile route")).toBeTruthy();
    await act(async () => {
      fireEvent.press(screen.getByLabelText("Open bound terminal"));
    });

    expect(AsyncStorage.setItem).toHaveBeenCalledWith(
      MOBILE_SHELL_STATE_STORAGE_KEY,
      expect.stringContaining('"lastActiveTerminalSessionId":"matrix-abc1234"'),
    );
    expect(mockRouterPush).toHaveBeenCalledWith("/terminal");
  });

  it("renders a readable bounded event timeline from the thread snapshot", async () => {
    const snapshot = {
      ...threadSnapshotFixture(),
      events: {
        ...threadSnapshotFixture().events,
        items: [
          ...threadSnapshotFixture().events.items,
          {
            eventId: "evt_mobile_3",
            threadId: "thread_mobile",
            type: "assistant.text.delta",
            messageId: "msg_mobile_1",
            delta: "Checking /home/matrix/secret and token_sk_live_123.",
            occurredAt: "2026-07-06T00:02:00.000Z",
          },
          {
            eventId: "evt_mobile_4",
            threadId: "thread_mobile",
            type: "tool.started",
            toolCallId: "tool_mobile_1",
            displayName: "Read source",
            kind: "file",
            occurredAt: "2026-07-06T00:02:30.000Z",
          },
          {
            eventId: "evt_mobile_5",
            threadId: "thread_mobile",
            type: "file.changed",
            path: ".ssh/id_rsa",
            changeKind: "updated",
            occurredAt: "2026-07-06T00:03:00.000Z",
          },
          {
            eventId: "evt_mobile_6",
            threadId: "thread_mobile",
            type: "review.ready",
            reviewId: "rev_mobile_1",
            summary: {
              changedFileCount: 2,
              additions: 12,
              deletions: 4,
              partial: true,
            },
            occurredAt: "2026-07-06T00:04:00.000Z",
          },
          {
            eventId: "evt_mobile_7",
            threadId: "thread_mobile",
            type: "thread.error",
            error: {
              code: "provider_failed",
              safeMessage: "/home/matrix/token leaked raw detail",
              retryable: true,
            },
            occurredAt: "2026-07-06T00:05:00.000Z",
          },
        ],
      },
    };
    const client = {
      getCodingAgentThreadSnapshot: jest.fn().mockResolvedValue({
        ok: true,
        snapshot,
      }),
    };
    useGatewayMock.mockReturnValue(gatewayContext({
      client: client as unknown as GatewayClient,
      connectionState: "connected",
    }));

    render(<AgentThreadRoute />);

    expect(await screen.findByText("Activity timeline")).toBeTruthy();
    expect(screen.getByText("Assistant update")).toBeTruthy();
    expect(screen.getByText("Text update received")).toBeTruthy();
    expect(screen.getByText("Tool started")).toBeTruthy();
    expect(screen.getByText("Read source")).toBeTruthy();
    expect(screen.getByText("File updated")).toBeTruthy();
    expect(screen.getByText("Updated file")).toBeTruthy();
    expect(screen.getByText("Review ready")).toBeTruthy();
    expect(screen.getByText("2 files changed, +12 -4, partial")).toBeTruthy();
    expect(screen.getByText("Thread needs attention")).toBeTruthy();
    expect(screen.getByText("Refresh the thread or check the runtime.")).toBeTruthy();
    expect(screen.queryByText(/home\/matrix|token|leaked|\.ssh|id_rsa/i)).toBeNull();
  });

  it("renders a generic thread error without exposing raw gateway details", async () => {
    const client = {
      getCodingAgentThreadSnapshot: jest.fn().mockResolvedValue({
        ok: false,
        error: "Thread state unavailable",
      }),
    };
    useGatewayMock.mockReturnValue(gatewayContext({
      client: client as unknown as GatewayClient,
      connectionState: "connected",
    }));

    render(<AgentThreadRoute />);

    await waitFor(() => {
      expect(screen.getByText("Thread state unavailable")).toBeTruthy();
    });
    expect(screen.queryByText(/home\/matrix|token|secret/i)).toBeNull();
  });

  it("keeps the last good thread snapshot visible when refresh fails", async () => {
    const client = {
      getCodingAgentThreadSnapshot: jest.fn()
        .mockResolvedValueOnce({
          ok: true,
          snapshot: threadSnapshotFixture(),
        })
        .mockResolvedValueOnce({
          ok: false,
          error: "Thread state unavailable",
        }),
    };
    useGatewayMock.mockReturnValue(gatewayContext({
      client: client as unknown as GatewayClient,
      connectionState: "connected",
    }));

    render(<AgentThreadRoute />);

    expect(await screen.findByText("Repair mobile route")).toBeTruthy();
    await act(async () => {
      fireEvent.press(screen.getByLabelText("Refresh thread"));
    });

    expect(await screen.findByText("Thread state unavailable")).toBeTruthy();
    expect(screen.getByText("Repair mobile route")).toBeTruthy();
    expect(screen.getByText("2 events")).toBeTruthy();
    expect(screen.queryByText(/home\/matrix|token|secret/i)).toBeNull();
  });

  it("ignores stale thread refresh responses that resolve after newer snapshots", async () => {
    const staleRefresh = deferred<{ ok: true; snapshot: ReturnType<typeof threadSnapshotFixture> }>();
    const freshRefresh = deferred<{ ok: true; snapshot: ReturnType<typeof threadSnapshotFixture> }>();
    const staleSnapshot = {
      ...threadSnapshotFixture(),
      thread: {
        ...threadSnapshotFixture().thread,
        title: "Stale mobile route",
        updatedAt: "2026-07-06T00:02:00.000Z",
      },
    };
    const freshSnapshot = {
      ...threadSnapshotFixture(),
      thread: {
        ...threadSnapshotFixture().thread,
        title: "Fresh mobile route",
        updatedAt: "2026-07-06T00:03:00.000Z",
      },
      events: {
        ...threadSnapshotFixture().events,
        items: threadSnapshotFixture().events.items.slice(0, 1),
      },
    };
    const client = {
      getCodingAgentThreadSnapshot: jest.fn()
        .mockResolvedValueOnce({
          ok: true,
          snapshot: threadSnapshotFixture(),
        })
        .mockImplementationOnce(() => staleRefresh.promise)
        .mockImplementationOnce(() => freshRefresh.promise),
    };
    useGatewayMock.mockReturnValue(gatewayContext({
      client: client as unknown as GatewayClient,
      connectionState: "connected",
    }));

    render(<AgentThreadRoute />);

    expect(await screen.findByText("Repair mobile route")).toBeTruthy();
    await act(async () => {
      fireEvent.press(screen.getByLabelText("Refresh thread"));
      fireEvent.press(screen.getByLabelText("Refresh thread"));
    });

    await act(async () => {
      freshRefresh.resolve({ ok: true, snapshot: freshSnapshot });
      await freshRefresh.promise;
    });

    expect(await screen.findByText("Fresh mobile route")).toBeTruthy();
    expect(screen.getByText("1 event")).toBeTruthy();

    await act(async () => {
      staleRefresh.resolve({ ok: true, snapshot: staleSnapshot });
      await staleRefresh.promise;
    });

    await waitFor(() => {
      expect(screen.queryByText("Stale mobile route")).toBeNull();
    });
    expect(screen.getByText("Fresh mobile route")).toBeTruthy();
    expect(screen.getByText("1 event")).toBeTruthy();
  });
});
