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

function attentionThreadSnapshotFixture(attention: "approval_required" | "input_required" | "failed") {
  return {
    ...threadSnapshotFixture(),
    thread: {
      ...threadSnapshotFixture().thread,
      status: attention === "failed" ? "failed" : attention === "approval_required" ? "waiting_for_approval" : "waiting_for_input",
      attention,
    },
  };
}

function approvalRequestedSnapshotFixture() {
  const snapshot = threadSnapshotFixture();
  return {
    ...snapshot,
    events: {
      ...snapshot.events,
      items: [
        ...snapshot.events.items,
        {
          eventId: "evt_mobile_approval_requested",
          threadId: "thread_mobile",
          type: "approval.requested",
          approval: {
            approvalId: "appr_mobile_1",
            threadId: "thread_mobile",
            title: "Run focused tests",
            safeDescription: "Run the focused mobile thread test command.",
            risk: "low",
            actionKind: "command",
            allowedDecisions: ["approve", "decline"],
            correlationId: "corr_mobile_approval_1",
          },
          occurredAt: "2026-07-06T00:02:00.000Z",
        },
      ],
    },
  };
}

function approvalResolvedSnapshotFixture() {
  const snapshot = threadSnapshotFixture();
  return {
    ...snapshot,
    events: {
      ...snapshot.events,
      items: [
        ...snapshot.events.items,
        {
          eventId: "evt_mobile_approval_resolved",
          threadId: "thread_mobile",
          type: "approval.resolved",
          approvalId: "appr_mobile_1",
          decision: "approve",
          occurredAt: "2026-07-06T00:03:00.000Z",
        },
      ],
    },
  };
}

function approvalRequestedAndResolvedSnapshotFixture() {
  const requested = approvalRequestedSnapshotFixture();
  return {
    ...requested,
    events: {
      ...requested.events,
      items: [
        ...requested.events.items,
        {
          eventId: "evt_mobile_approval_resolved",
          threadId: "thread_mobile",
          type: "approval.resolved",
          approvalId: "appr_mobile_1",
          decision: "approve",
          occurredAt: "2026-07-06T00:03:00.000Z",
        },
      ],
    },
  };
}

function twoApprovalRequestsSnapshotFixture() {
  const snapshot = approvalRequestedSnapshotFixture();
  return {
    ...snapshot,
    events: {
      ...snapshot.events,
      items: [
        ...snapshot.events.items,
        {
          eventId: "evt_mobile_approval_requested_2",
          threadId: "thread_mobile",
          type: "approval.requested",
          approval: {
            approvalId: "appr_mobile_2",
            threadId: "thread_mobile",
            title: "Update fixture",
            safeDescription: "Update the focused mobile fixture.",
            risk: "low",
            actionKind: "file_change",
            allowedDecisions: ["approve", "decline"],
            correlationId: "corr_mobile_approval_2",
          },
          occurredAt: "2026-07-06T00:02:30.000Z",
        },
      ],
    },
  };
}

function inputRequestedSnapshotFixture() {
  const snapshot = threadSnapshotFixture();
  return {
    ...snapshot,
    events: {
      ...snapshot.events,
      items: [
        ...snapshot.events.items,
        {
          eventId: "evt_mobile_input_requested",
          threadId: "thread_mobile",
          type: "user_input.requested",
          request: {
            requestId: "req_mobile_prompt_1",
            threadId: "thread_mobile",
            title: "Clarify command",
            safeDescription: "Provide the next safe instruction for this run.",
            placeholder: "Type an instruction",
            required: true,
            correlationId: "corr_mobile_input_1",
          },
          occurredAt: "2026-07-06T00:02:00.000Z",
        },
      ],
    },
  };
}

function inputAnsweredSnapshotFixture() {
  const snapshot = threadSnapshotFixture();
  return {
    ...snapshot,
    events: {
      ...snapshot.events,
      items: [
        ...snapshot.events.items,
        {
          eventId: "evt_mobile_input_answered",
          threadId: "thread_mobile",
          type: "user_input.answered",
          requestId: "req_mobile_prompt_1",
          correlationId: "corr_mobile_input_1",
          occurredAt: "2026-07-06T00:03:00.000Z",
        },
      ],
    },
  };
}

function inputRequestedAndAnsweredSnapshotFixture() {
  const requested = inputRequestedSnapshotFixture();
  return {
    ...requested,
    events: {
      ...requested.events,
      items: [
        ...requested.events.items,
        {
          eventId: "evt_mobile_input_answered",
          threadId: "thread_mobile",
          type: "user_input.answered",
          requestId: "req_mobile_prompt_1",
          correlationId: "corr_mobile_input_1",
          occurredAt: "2026-07-06T00:03:00.000Z",
        },
      ],
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

  it("opens a bounded follow-up composer for the current thread", async () => {
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
    fireEvent.press(screen.getByLabelText("Ask follow-up about this thread"));

    expect(mockRouterPush).toHaveBeenCalledWith({
      pathname: "/agents/new",
      params: {
        sourceThreadId: "thread_mobile",
        sourceThreadTitle: "Repair mobile route",
        sourceProviderId: "codex",
      },
    });
  });

  it("submits an approval decision and applies the returned thread snapshot", async () => {
    const client = {
      getCodingAgentThreadSnapshot: jest.fn().mockResolvedValue({
        ok: true,
        snapshot: approvalRequestedSnapshotFixture(),
      }),
      submitCodingAgentApprovalDecision: jest.fn().mockResolvedValue({
        ok: true,
        snapshot: approvalResolvedSnapshotFixture(),
      }),
    };
    useGatewayMock.mockReturnValue(gatewayContext({
      client: client as unknown as GatewayClient,
      connectionState: "connected",
    }));

    render(<AgentThreadRoute />);

    expect(await screen.findByText("Approval needed")).toBeTruthy();
    expect(screen.getByText("Run the focused mobile thread test command.")).toBeTruthy();
    await act(async () => {
      fireEvent.press(screen.getByLabelText("Approve Run focused tests"));
    });

    expect(client.submitCodingAgentApprovalDecision).toHaveBeenCalledWith(expect.objectContaining({
      threadId: "thread_mobile",
      approvalId: "appr_mobile_1",
      decision: "approve",
      correlationId: "corr_mobile_approval_1",
      clientRequestId: expect.stringMatching(/^req_mobile_/),
    }));
    expect(await screen.findByText("Approval resolved")).toBeTruthy();
    expect(screen.queryByText("Run the focused mobile thread test command.")).toBeNull();
  });

  it.each([
    ["approval_required", "Approval needed", "Review the request and choose a safe decision."],
    ["input_required", "Input needed", "Answer the prompt to keep this run moving."],
    ["failed", "Run failed", "Open the thread activity or start a follow-up run."],
  ] as const)("renders a safe attention banner for %s", async (attention, title, detail) => {
    const client = {
      getCodingAgentThreadSnapshot: jest.fn().mockResolvedValue({
        ok: true,
        snapshot: attentionThreadSnapshotFixture(attention),
      }),
    };
    useGatewayMock.mockReturnValue(gatewayContext({
      client: client as unknown as GatewayClient,
      connectionState: "connected",
    }));

    render(<AgentThreadRoute />);

    expect(await screen.findByText(title)).toBeTruthy();
    expect(screen.getByText(detail)).toBeTruthy();
    expect(screen.queryByText(/home\/matrix|token|secret|stack trace/i)).toBeNull();
  });

  it("submits a user input answer and applies the returned thread snapshot", async () => {
    const client = {
      getCodingAgentThreadSnapshot: jest.fn().mockResolvedValue({
        ok: true,
        snapshot: inputRequestedSnapshotFixture(),
      }),
      submitCodingAgentInputAnswer: jest.fn().mockResolvedValue({
        ok: true,
        snapshot: inputAnsweredSnapshotFixture(),
      }),
    };
    useGatewayMock.mockReturnValue(gatewayContext({
      client: client as unknown as GatewayClient,
      connectionState: "connected",
    }));

    render(<AgentThreadRoute />);

    expect(await screen.findByText("Input needed")).toBeTruthy();
    fireEvent.changeText(screen.getByLabelText("Answer Clarify command"), "Run the focused mobile screen test.");
    await act(async () => {
      fireEvent.press(screen.getByLabelText("Send Clarify command"));
    });

    expect(client.submitCodingAgentInputAnswer).toHaveBeenCalledWith(expect.objectContaining({
      threadId: "thread_mobile",
      inputRequestId: "req_mobile_prompt_1",
      answer: "Run the focused mobile screen test.",
      correlationId: "corr_mobile_input_1",
      clientRequestId: expect.stringMatching(/^req_mobile_/),
    }));
    expect(await screen.findByText("Input answered")).toBeTruthy();
    expect(screen.queryByLabelText("Answer Clarify command")).toBeNull();
  });

  it("does not render approval actions once the approval is resolved", async () => {
    const client = {
      getCodingAgentThreadSnapshot: jest.fn().mockResolvedValue({
        ok: true,
        snapshot: approvalRequestedAndResolvedSnapshotFixture(),
      }),
      submitCodingAgentApprovalDecision: jest.fn(),
    };
    useGatewayMock.mockReturnValue(gatewayContext({
      client: client as unknown as GatewayClient,
      connectionState: "connected",
    }));

    render(<AgentThreadRoute />);

    expect(await screen.findByText("Approval needed")).toBeTruthy();
    expect(screen.getByText("Approval resolved")).toBeTruthy();
    expect(screen.queryByLabelText("Approve Run focused tests")).toBeNull();
  });

  it("does not render an input composer once the input is answered", async () => {
    const client = {
      getCodingAgentThreadSnapshot: jest.fn().mockResolvedValue({
        ok: true,
        snapshot: inputRequestedAndAnsweredSnapshotFixture(),
      }),
      submitCodingAgentInputAnswer: jest.fn(),
    };
    useGatewayMock.mockReturnValue(gatewayContext({
      client: client as unknown as GatewayClient,
      connectionState: "connected",
    }));

    render(<AgentThreadRoute />);

    expect(await screen.findByText("Input needed")).toBeTruthy();
    expect(screen.getByText("Input answered")).toBeTruthy();
    expect(screen.queryByLabelText("Answer Clarify command")).toBeNull();
  });

  it("keeps pending approval decisions scoped to the matching row", async () => {
    const pendingDecision = deferred<{ ok: true; snapshot: ReturnType<typeof twoApprovalRequestsSnapshotFixture> }>();
    const client = {
      getCodingAgentThreadSnapshot: jest.fn().mockResolvedValue({
        ok: true,
        snapshot: twoApprovalRequestsSnapshotFixture(),
      }),
      submitCodingAgentApprovalDecision: jest.fn()
        .mockImplementationOnce(() => pendingDecision.promise)
        .mockResolvedValueOnce({
          ok: true,
          snapshot: twoApprovalRequestsSnapshotFixture(),
        }),
    };
    useGatewayMock.mockReturnValue(gatewayContext({
      client: client as unknown as GatewayClient,
      connectionState: "connected",
    }));

    render(<AgentThreadRoute />);

    expect(await screen.findByLabelText("Approve Run focused tests")).toBeTruthy();
    await act(async () => {
      fireEvent.press(screen.getByLabelText("Approve Run focused tests"));
    });
    await act(async () => {
      fireEvent.press(screen.getByLabelText("Approve Update fixture"));
    });

    expect(client.submitCodingAgentApprovalDecision).toHaveBeenCalledTimes(2);
    expect(client.submitCodingAgentApprovalDecision).toHaveBeenLastCalledWith(expect.objectContaining({
      approvalId: "appr_mobile_2",
    }));

    await act(async () => {
      pendingDecision.resolve({ ok: true, snapshot: twoApprovalRequestsSnapshotFixture() });
      await pendingDecision.promise;
    });
  });

  it("keeps approval errors scoped to the matching row", async () => {
    const client = {
      getCodingAgentThreadSnapshot: jest.fn().mockResolvedValue({
        ok: true,
        snapshot: twoApprovalRequestsSnapshotFixture(),
      }),
      submitCodingAgentApprovalDecision: jest.fn().mockResolvedValue({
        ok: false,
        error: "Approval could not be sent. Try again.",
      }),
    };
    useGatewayMock.mockReturnValue(gatewayContext({
      client: client as unknown as GatewayClient,
      connectionState: "connected",
    }));

    render(<AgentThreadRoute />);

    expect(await screen.findByLabelText("Approve Run focused tests")).toBeTruthy();
    await act(async () => {
      fireEvent.press(screen.getByLabelText("Approve Run focused tests"));
    });

    expect(await screen.findByText("Approval could not be sent. Try again.")).toBeTruthy();
    expect(screen.getAllByText("Approval could not be sent. Try again.")).toHaveLength(1);
  });

  it("does not open a stale terminal session when safe resume state cannot be saved", async () => {
    jest.mocked(AsyncStorage.setItem).mockRejectedValueOnce(new Error("storage unavailable"));
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => undefined);
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

    expect(mockRouterPush).not.toHaveBeenCalled();
    expect(await screen.findByText("Terminal session unavailable. Try again.")).toBeTruthy();
    warnSpy.mockRestore();
  });

  it("does not open terminal fallback when the bound session id is not attachable", async () => {
    const snapshot = threadSnapshotFixture();
    snapshot.thread.terminalSessionId = "term_sess_workspace_1";
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

    expect(await screen.findByText("Repair mobile route")).toBeTruthy();
    await act(async () => {
      fireEvent.press(screen.getByLabelText("Open bound terminal"));
    });

    expect(AsyncStorage.setItem).not.toHaveBeenCalled();
    expect(mockRouterPush).not.toHaveBeenCalled();
    expect(await screen.findByText("Terminal session unavailable. Try again.")).toBeTruthy();
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
