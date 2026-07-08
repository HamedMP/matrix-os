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
import { AppState, Text } from "react-native";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import AgentThreadRoute from "../app/agents/[threadId]";
import { useGateway } from "@/app/_layout";
import { MOBILE_SHELL_STATE_STORAGE_KEY } from "../lib/mobile-shell-state";
import type { CodingAgentThreadEventSubscriptionOptions, GatewayClient } from "../lib/gateway-client";

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

  it("merges bounded live thread stream events into the timeline", async () => {
    let streamOptions: CodingAgentThreadEventSubscriptionOptions | null = null;
    const detach = jest.fn();
    const client = {
      getCodingAgentThreadSnapshot: jest.fn().mockResolvedValue({
        ok: true,
        snapshot: threadSnapshotFixture(),
      }),
      subscribeCodingAgentThreadEvents: jest.fn().mockImplementation((options: CodingAgentThreadEventSubscriptionOptions) => {
        streamOptions = options;
        return Promise.resolve({ detach });
      }),
    };
    useGatewayMock.mockReturnValue(gatewayContext({
      client: client as unknown as GatewayClient,
      connectionState: "connected",
    }));

    render(<AgentThreadRoute />);

    expect(await screen.findByText("Repair mobile route")).toBeTruthy();
    await waitFor(() => {
      expect(client.subscribeCodingAgentThreadEvents).toHaveBeenCalledWith(expect.objectContaining({
        threadId: "thread_mobile",
        onEvent: expect.any(Function),
      }));
    });

    await act(async () => {
      streamOptions?.onEvent({
        eventId: "evt_mobile_stream_1",
        threadId: "thread_mobile",
        type: "assistant.text.delta",
        messageId: "msg_mobile_stream_1",
        delta: "Reading /home/matrix/secret and token_sk_live_123.",
        occurredAt: "2026-07-06T00:02:00.000Z",
      });
    });

    expect(screen.getByText("3 events")).toBeTruthy();
    expect(screen.getByText("Assistant update")).toBeTruthy();
    expect(screen.getByText("Text update received")).toBeTruthy();
    expect(screen.queryByText(/home\/matrix|token|secret/i)).toBeNull();
  });

  it("applies live thread stream events to safe thread metadata", async () => {
    let streamOptions: CodingAgentThreadEventSubscriptionOptions | null = null;
    const client = {
      getCodingAgentThreadSnapshot: jest.fn().mockResolvedValue({
        ok: true,
        snapshot: threadSnapshotFixture(),
      }),
      subscribeCodingAgentThreadEvents: jest.fn().mockImplementation((options: CodingAgentThreadEventSubscriptionOptions) => {
        streamOptions = options;
        return Promise.resolve({ detach: jest.fn() });
      }),
    };
    useGatewayMock.mockReturnValue(gatewayContext({
      client: client as unknown as GatewayClient,
      connectionState: "connected",
    }));

    render(<AgentThreadRoute />);

    expect(await screen.findByText("Repair mobile route")).toBeTruthy();
    await waitFor(() => expect(streamOptions).not.toBeNull());

    await act(async () => {
      streamOptions?.onEvent({
        eventId: "evt_mobile_terminal_stream",
        threadId: "thread_mobile",
        type: "terminal.bound",
        terminalSessionId: "matrix-new5678",
        occurredAt: "2026-07-06T00:02:00.000Z",
      });
      streamOptions?.onEvent({
        eventId: "evt_mobile_completed_stream",
        threadId: "thread_mobile",
        type: "thread.completed",
        outcome: "completed",
        occurredAt: "2026-07-06T00:03:00.000Z",
      });
    });

    expect(screen.getAllByText("completed").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("matrix-new5678").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("2026-07-06T00:03:00.000Z")).toBeTruthy();
  });

  it("keeps the thread visible with a generic error when stream startup fails", async () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    const client = {
      getCodingAgentThreadSnapshot: jest.fn().mockResolvedValue({
        ok: true,
        snapshot: threadSnapshotFixture(),
      }),
      subscribeCodingAgentThreadEvents: jest.fn().mockRejectedValue(new Error("socket leaked /home/matrix/token")),
    };
    useGatewayMock.mockReturnValue(gatewayContext({
      client: client as unknown as GatewayClient,
      connectionState: "connected",
    }));

    render(<AgentThreadRoute />);

    expect(await screen.findByText("Repair mobile route")).toBeTruthy();
    expect(await screen.findByText("Thread state unavailable")).toBeTruthy();
    expect(screen.queryByText(/home\/matrix|token|socket leaked/i)).toBeNull();
    warnSpy.mockRestore();
  });

  it("orders live thread events by occurrence time instead of delivery order", async () => {
    let streamOptions: CodingAgentThreadEventSubscriptionOptions | null = null;
    const client = {
      getCodingAgentThreadSnapshot: jest.fn().mockResolvedValue({
        ok: true,
        snapshot: threadSnapshotFixture(),
      }),
      subscribeCodingAgentThreadEvents: jest.fn().mockImplementation((options: CodingAgentThreadEventSubscriptionOptions) => {
        streamOptions = options;
        return Promise.resolve({ detach: jest.fn() });
      }),
    };
    useGatewayMock.mockReturnValue(gatewayContext({
      client: client as unknown as GatewayClient,
      connectionState: "connected",
    }));

    const rendered = render(<AgentThreadRoute />);

    expect(await screen.findByText("Repair mobile route")).toBeTruthy();
    await waitFor(() => expect(streamOptions).not.toBeNull());

    await act(async () => {
      streamOptions?.onEvent({
        eventId: "evt_mobile_late_complete",
        threadId: "thread_mobile",
        type: "thread.completed",
        outcome: "completed",
        occurredAt: "2026-07-06T00:04:00.000Z",
      });
      streamOptions?.onEvent({
        eventId: "evt_mobile_early_approval",
        threadId: "thread_mobile",
        type: "approval.requested",
        approval: {
          approvalId: "appr_mobile_ordering",
          threadId: "thread_mobile",
          title: "Review streamed command",
          safeDescription: "Review the streamed command before it runs.",
          risk: "low",
          actionKind: "command",
          allowedDecisions: ["approve", "decline"],
          correlationId: "corr_mobile_ordering",
        },
        occurredAt: "2026-07-06T00:02:00.000Z",
      });
    });

    const textValues = rendered.UNSAFE_queryAllByType(Text)
      .map((node) => node.props.children)
      .filter((value): value is string => typeof value === "string");
    expect(textValues.indexOf("Approval needed")).toBeLessThan(textValues.indexOf("Thread completed"));
  });

  it("keeps same-timestamp resolved approvals from reopening thread attention", async () => {
    let streamOptions: CodingAgentThreadEventSubscriptionOptions | null = null;
    const client = {
      getCodingAgentThreadSnapshot: jest.fn().mockResolvedValue({
        ok: true,
        snapshot: threadSnapshotFixture(),
      }),
      subscribeCodingAgentThreadEvents: jest.fn().mockImplementation((options: CodingAgentThreadEventSubscriptionOptions) => {
        streamOptions = options;
        return Promise.resolve({ detach: jest.fn() });
      }),
    };
    useGatewayMock.mockReturnValue(gatewayContext({
      client: client as unknown as GatewayClient,
      connectionState: "connected",
    }));

    render(<AgentThreadRoute />);

    expect(await screen.findByText("Repair mobile route")).toBeTruthy();
    await waitFor(() => expect(streamOptions).not.toBeNull());

    await act(async () => {
      streamOptions?.onEvent({
        eventId: "evt_a_resolved_same_time",
        threadId: "thread_mobile",
        type: "approval.resolved",
        approvalId: "appr_mobile_same_time",
        decision: "approve",
        occurredAt: "2026-07-06T00:02:00.000Z",
      });
      streamOptions?.onEvent({
        eventId: "evt_z_requested_same_time",
        threadId: "thread_mobile",
        type: "approval.requested",
        approval: {
          approvalId: "appr_mobile_same_time",
          threadId: "thread_mobile",
          title: "Same timestamp approval",
          safeDescription: "Review same timestamp approval.",
          risk: "low",
          actionKind: "command",
          allowedDecisions: ["approve", "decline"],
          correlationId: "corr_mobile_same_time",
        },
        occurredAt: "2026-07-06T00:02:00.000Z",
      });
    });

    expect(screen.queryByText("waiting for approval")).toBeNull();
    expect(screen.queryByText("Review the request and choose a safe decision.")).toBeNull();
    expect(screen.queryByLabelText("Approve Same timestamp approval")).toBeNull();
  });

  it("keeps existing blocked attention when unrelated live events arrive outside the request window", async () => {
    let streamOptions: CodingAgentThreadEventSubscriptionOptions | null = null;
    const snapshot = attentionThreadSnapshotFixture("approval_required");
    const client = {
      getCodingAgentThreadSnapshot: jest.fn().mockResolvedValue({
        ok: true,
        snapshot,
      }),
      subscribeCodingAgentThreadEvents: jest.fn().mockImplementation((options: CodingAgentThreadEventSubscriptionOptions) => {
        streamOptions = options;
        return Promise.resolve({ detach: jest.fn() });
      }),
    };
    useGatewayMock.mockReturnValue(gatewayContext({
      client: client as unknown as GatewayClient,
      connectionState: "connected",
    }));

    render(<AgentThreadRoute />);

    expect(await screen.findByText("Approval needed")).toBeTruthy();
    await waitFor(() => expect(streamOptions).not.toBeNull());

    await act(async () => {
      streamOptions?.onEvent({
        eventId: "evt_mobile_unrelated_stream",
        threadId: "thread_mobile",
        type: "assistant.text.delta",
        messageId: "msg_mobile_unrelated_stream",
        delta: "Still working.",
        occurredAt: "2026-07-06T00:03:00.000Z",
      });
    });

    expect(screen.getByText("waiting for approval")).toBeTruthy();
    expect(screen.getByText("Review the request and choose a safe decision.")).toBeTruthy();
  });

  it("applies late resolution events as running summary state", async () => {
    let streamOptions: CodingAgentThreadEventSubscriptionOptions | null = null;
    const snapshot = attentionThreadSnapshotFixture("failed");
    const client = {
      getCodingAgentThreadSnapshot: jest.fn().mockResolvedValue({
        ok: true,
        snapshot,
      }),
      subscribeCodingAgentThreadEvents: jest.fn().mockImplementation((options: CodingAgentThreadEventSubscriptionOptions) => {
        streamOptions = options;
        return Promise.resolve({ detach: jest.fn() });
      }),
    };
    useGatewayMock.mockReturnValue(gatewayContext({
      client: client as unknown as GatewayClient,
      connectionState: "connected",
    }));

    render(<AgentThreadRoute />);

    expect(await screen.findByText("Run failed")).toBeTruthy();
    await waitFor(() => expect(streamOptions).not.toBeNull());

    await act(async () => {
      streamOptions?.onEvent({
        eventId: "evt_mobile_late_resolution",
        threadId: "thread_mobile",
        type: "approval.resolved",
        approvalId: "appr_mobile_late_resolution",
        decision: "approve",
        occurredAt: "2026-07-06T00:03:00.000Z",
      });
    });

    expect(screen.getAllByText("running").length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText("Run failed")).toBeNull();
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
    expect(screen.getAllByText("Run the focused mobile thread test command.")).toHaveLength(2);
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

  it("surfaces a current approval action before the timeline", async () => {
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

    expect(await screen.findByText("Current action")).toBeTruthy();
    expect(screen.getByText("Run focused tests")).toBeTruthy();
    expect(screen.getAllByText("Run the focused mobile thread test command.")).toHaveLength(2);
    expect(screen.queryByText(/appr_mobile|corr_mobile|home\/matrix|token|secret|stack trace/i)).toBeNull();

    await act(async () => {
      fireEvent.press(screen.getByLabelText("Approve current action Run focused tests"));
    });

    expect(client.submitCodingAgentApprovalDecision).toHaveBeenCalledWith(expect.objectContaining({
      approvalId: "appr_mobile_1",
      decision: "approve",
      correlationId: "corr_mobile_approval_1",
    }));
    expect(await screen.findByText("Approval resolved")).toBeTruthy();
  });

  it("guards duplicate approval submissions across pinned and timeline controls", async () => {
    const pendingDecision = deferred<{ ok: true; snapshot: ReturnType<typeof approvalResolvedSnapshotFixture> }>();
    const client = {
      getCodingAgentThreadSnapshot: jest.fn().mockResolvedValue({
        ok: true,
        snapshot: approvalRequestedSnapshotFixture(),
      }),
      submitCodingAgentApprovalDecision: jest.fn().mockImplementation(() => pendingDecision.promise),
    };
    useGatewayMock.mockReturnValue(gatewayContext({
      client: client as unknown as GatewayClient,
      connectionState: "connected",
    }));

    render(<AgentThreadRoute />);

    expect(await screen.findByLabelText("Approve current action Run focused tests")).toBeTruthy();
    await act(async () => {
      fireEvent.press(screen.getByLabelText("Approve current action Run focused tests"));
      fireEvent.press(screen.getByLabelText("Decline Run focused tests"));
    });

    expect(client.submitCodingAgentApprovalDecision).toHaveBeenCalledTimes(1);
    expect(client.submitCodingAgentApprovalDecision).toHaveBeenCalledWith(expect.objectContaining({
      decision: "approve",
    }));

    await act(async () => {
      pendingDecision.resolve({ ok: true, snapshot: approvalResolvedSnapshotFixture() });
      await pendingDecision.promise;
    });
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

  it("surfaces a current input action before the timeline", async () => {
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

    expect(await screen.findByText("Current action")).toBeTruthy();
    expect(screen.getByText("Clarify command")).toBeTruthy();
    expect(screen.getAllByText("Provide the next safe instruction for this run.")).toHaveLength(2);
    expect(screen.queryByText(/req_mobile|corr_mobile|home\/matrix|token|secret|stack trace/i)).toBeNull();

    fireEvent.changeText(screen.getByLabelText("Answer current action Clarify command"), "Run the focused mobile screen test.");
    await act(async () => {
      fireEvent.press(screen.getByLabelText("Send current action Clarify command"));
    });

    expect(client.submitCodingAgentInputAnswer).toHaveBeenCalledWith(expect.objectContaining({
      inputRequestId: "req_mobile_prompt_1",
      answer: "Run the focused mobile screen test.",
      correlationId: "corr_mobile_input_1",
    }));
    expect(await screen.findByText("Input answered")).toBeTruthy();
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
    expect(screen.getByText("Read source")).toBeTruthy();
    expect(screen.getByText("Running")).toBeTruthy();
    expect(screen.getByText("File updated")).toBeTruthy();
    expect(screen.getByText("Updated file")).toBeTruthy();
    expect(screen.getByText("Review ready")).toBeTruthy();
    expect(screen.getByText("2 files changed, +12 -4, partial")).toBeTruthy();
    expect(screen.getByText("Thread needs attention")).toBeTruthy();
    expect(screen.getByText("Refresh the thread or check the runtime.")).toBeTruthy();
    expect(screen.queryByText(/home\/matrix|token|leaked|\.ssh|id_rsa/i)).toBeNull();
  });

  it("groups assistant message activity without exposing raw text", async () => {
    const snapshot = {
      ...threadSnapshotFixture(),
      events: {
        ...threadSnapshotFixture().events,
        items: [
          ...threadSnapshotFixture().events.items,
          {
            eventId: "evt_mobile_assistant_delta_1",
            threadId: "thread_mobile",
            type: "assistant.text.delta",
            messageId: "msg_mobile_grouped",
            delta: "Reading /home/matrix/private and token_sk_live_123.",
            occurredAt: "2026-07-06T00:02:00.000Z",
          },
          {
            eventId: "evt_mobile_assistant_file",
            threadId: "thread_mobile",
            type: "file.changed",
            path: "apps/mobile/app/agents/[threadId].tsx",
            changeKind: "updated",
            occurredAt: "2026-07-06T00:02:30.000Z",
          },
          {
            eventId: "evt_mobile_assistant_delta_2",
            threadId: "thread_mobile",
            type: "assistant.text.delta",
            messageId: "msg_mobile_grouped",
            delta: "Finished with secret local output.",
            occurredAt: "2026-07-06T00:02:45.000Z",
          },
          {
            eventId: "evt_mobile_assistant_completed",
            threadId: "thread_mobile",
            type: "assistant.text.completed",
            messageId: "msg_mobile_grouped",
            occurredAt: "2026-07-06T00:03:00.000Z",
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

    const rendered = render(<AgentThreadRoute />);

    expect(await screen.findByText("Assistant message")).toBeTruthy();
    expect(screen.getByText("2 text updates received, complete")).toBeTruthy();
    expect(screen.queryByText("Assistant message complete")).toBeNull();
    expect(screen.queryByText("msg_mobile_grouped")).toBeNull();
    expect(screen.queryByText(/home\/matrix|token|secret local output/i)).toBeNull();
    const textValues = rendered.UNSAFE_queryAllByType(Text)
      .map((node) => node.props.children)
      .filter((value): value is string => typeof value === "string");
    expect(textValues.indexOf("File updated")).toBeLessThan(textValues.indexOf("Assistant message"));
  });

  it("groups bounded tool activity without exposing raw tool output", async () => {
    const snapshot = {
      ...threadSnapshotFixture(),
      events: {
        ...threadSnapshotFixture().events,
        items: [
          ...threadSnapshotFixture().events.items,
          {
            eventId: "evt_mobile_tool_started",
            threadId: "thread_mobile",
            type: "tool.started",
            toolCallId: "tool_mobile_grouped",
            displayName: "Run focused tests",
            kind: "command",
            occurredAt: "2026-07-06T00:02:00.000Z",
          },
          {
            eventId: "evt_mobile_tool_output",
            threadId: "thread_mobile",
            type: "tool.output",
            toolCallId: "tool_mobile_grouped",
            text: "stdout leaked /home/matrix/private and token_sk_live_123",
            truncated: true,
            occurredAt: "2026-07-06T00:02:30.000Z",
          },
          {
            eventId: "evt_mobile_tool_completed",
            threadId: "thread_mobile",
            type: "tool.completed",
            toolCallId: "tool_mobile_grouped",
            outcome: "success",
            occurredAt: "2026-07-06T00:03:00.000Z",
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

    expect(await screen.findByText("Run focused tests")).toBeTruthy();
    expect(screen.getByText("Completed successfully, partial output received")).toBeTruthy();
    expect(screen.queryByText("Tool started")).toBeNull();
    expect(screen.queryByText("Tool output")).toBeNull();
    expect(screen.queryByText("Tool completed")).toBeNull();
    expect(screen.queryByText(/home\/matrix|token|stdout leaked/i)).toBeNull();
  });

  it("keeps grouped tool outcomes ordered after interleaved events", async () => {
    const snapshot = {
      ...threadSnapshotFixture(),
      events: {
        ...threadSnapshotFixture().events,
        items: [
          ...threadSnapshotFixture().events.items,
          {
            eventId: "evt_mobile_interleaved_tool_started",
            threadId: "thread_mobile",
            type: "tool.started",
            toolCallId: "tool_mobile_interleaved",
            displayName: "Run tests",
            kind: "command",
            occurredAt: "2026-07-06T00:02:00.000Z",
          },
          {
            eventId: "evt_mobile_interleaved_file",
            threadId: "thread_mobile",
            type: "file.changed",
            path: "apps/mobile/app/agents/[threadId].tsx",
            changeKind: "updated",
            occurredAt: "2026-07-06T00:02:30.000Z",
          },
          {
            eventId: "evt_mobile_interleaved_tool_completed",
            threadId: "thread_mobile",
            type: "tool.completed",
            toolCallId: "tool_mobile_interleaved",
            outcome: "success",
            occurredAt: "2026-07-06T00:03:00.000Z",
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

    const rendered = render(<AgentThreadRoute />);

    expect(await screen.findByText("Run tests")).toBeTruthy();
    const textValues = rendered.UNSAFE_queryAllByType(Text)
      .map((node) => node.props.children)
      .filter((value): value is string => typeof value === "string");
    expect(textValues.indexOf("File updated")).toBeLessThan(textValues.indexOf("Completed successfully, no output received"));
  });

  it("keeps grouped tool completion anchored before late output", async () => {
    const snapshot = {
      ...threadSnapshotFixture(),
      events: {
        ...threadSnapshotFixture().events,
        items: [
          ...threadSnapshotFixture().events.items,
          {
            eventId: "evt_mobile_late_output_tool_started",
            threadId: "thread_mobile",
            type: "tool.started",
            toolCallId: "tool_mobile_late_output",
            displayName: "Run checks",
            kind: "command",
            occurredAt: "2026-07-06T00:02:00.000Z",
          },
          {
            eventId: "evt_mobile_late_output_tool_completed",
            threadId: "thread_mobile",
            type: "tool.completed",
            toolCallId: "tool_mobile_late_output",
            outcome: "success",
            occurredAt: "2026-07-06T00:02:30.000Z",
          },
          {
            eventId: "evt_mobile_late_output_file",
            threadId: "thread_mobile",
            type: "file.changed",
            path: "apps/mobile/app/agents/[threadId].tsx",
            changeKind: "updated",
            occurredAt: "2026-07-06T00:03:00.000Z",
          },
          {
            eventId: "evt_mobile_late_output_tool_output",
            threadId: "thread_mobile",
            type: "tool.output",
            toolCallId: "tool_mobile_late_output",
            text: "late stdout leaked token_sk_live_123",
            occurredAt: "2026-07-06T00:03:30.000Z",
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

    const rendered = render(<AgentThreadRoute />);

    expect(await screen.findByText("Run checks")).toBeTruthy();
    expect(screen.getByText("Completed successfully, output received")).toBeTruthy();
    const textValues = rendered.UNSAFE_queryAllByType(Text)
      .map((node) => node.props.children)
      .filter((value): value is string => typeof value === "string");
    expect(textValues.indexOf("Completed successfully, output received")).toBeLessThan(textValues.indexOf("File updated"));
    expect(screen.queryByText(/token|late stdout/i)).toBeNull();
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

  it("refreshes pending attention when the app resumes to the foreground", async () => {
    let appStateChange: ((state: string) => void) | null = null;
    const removeAppStateListener = jest.fn();
    const addEventListenerSpy = jest.spyOn(AppState, "addEventListener").mockImplementation((event, listener) => {
      if (event === "change") {
        appStateChange = listener as (state: string) => void;
      }
      return { remove: removeAppStateListener };
    });
    const client = {
      getCodingAgentThreadSnapshot: jest.fn()
        .mockResolvedValueOnce({
          ok: true,
          snapshot: approvalRequestedSnapshotFixture(),
        })
        .mockResolvedValueOnce({
          ok: true,
          snapshot: approvalRequestedAndResolvedSnapshotFixture(),
        }),
    };
    useGatewayMock.mockReturnValue(gatewayContext({
      client: client as unknown as GatewayClient,
      connectionState: "connected",
    }));

    const rendered = render(<AgentThreadRoute />);

    expect(await screen.findByText("Approval needed")).toBeTruthy();
    await act(async () => {
      appStateChange?.("background");
      appStateChange?.("active");
    });

    expect(await screen.findByText("Approval resolved")).toBeTruthy();
    expect(client.getCodingAgentThreadSnapshot).toHaveBeenCalledTimes(2);

    rendered.unmount();
    expect(removeAppStateListener).toHaveBeenCalled();
    addEventListenerSpy.mockRestore();
  });

  it("does not let a stale resume snapshot reopen a resolved approval", async () => {
    let appStateChange: ((state: string) => void) | null = null;
    const addEventListenerSpy = jest.spyOn(AppState, "addEventListener").mockImplementation((event, listener) => {
      if (event === "change") {
        appStateChange = listener as (state: string) => void;
      }
      return { remove: jest.fn() };
    });
    const staleResume = deferred<{ ok: true; snapshot: ReturnType<typeof approvalRequestedSnapshotFixture> }>();
    const approveResult = deferred<{ ok: true; snapshot: ReturnType<typeof approvalResolvedSnapshotFixture> }>();
    const client = {
      getCodingAgentThreadSnapshot: jest.fn()
        .mockResolvedValueOnce({
          ok: true,
          snapshot: approvalRequestedSnapshotFixture(),
        })
        .mockImplementationOnce(() => staleResume.promise),
      submitCodingAgentApprovalDecision: jest.fn().mockImplementation(() => approveResult.promise),
    };
    useGatewayMock.mockReturnValue(gatewayContext({
      client: client as unknown as GatewayClient,
      connectionState: "connected",
    }));

    render(<AgentThreadRoute />);

    expect(await screen.findByText("Approval needed")).toBeTruthy();
    await act(async () => {
      appStateChange?.("active");
    });
    await act(async () => {
      fireEvent.press(screen.getByLabelText("Approve Run focused tests"));
    });
    await act(async () => {
      approveResult.resolve({ ok: true, snapshot: approvalResolvedSnapshotFixture() });
      await approveResult.promise;
    });

    expect(await screen.findByText("Approval resolved")).toBeTruthy();

    await act(async () => {
      staleResume.resolve({ ok: true, snapshot: approvalRequestedSnapshotFixture() });
      await staleResume.promise;
    });

    expect(screen.getByText("Approval resolved")).toBeTruthy();
    expect(screen.queryByLabelText("Approve Run focused tests")).toBeNull();
    addEventListenerSpy.mockRestore();
  });

  it("does not attach a new stream after an in-flight resume refresh unmounts", async () => {
    let appStateChange: ((state: string) => void) | null = null;
    const addEventListenerSpy = jest.spyOn(AppState, "addEventListener").mockImplementation((event, listener) => {
      if (event === "change") {
        appStateChange = listener as (state: string) => void;
      }
      return { remove: jest.fn() };
    });
    const resumeRefresh = deferred<{ ok: true; snapshot: ReturnType<typeof threadSnapshotFixture> }>();
    const detach = jest.fn();
    const client = {
      getCodingAgentThreadSnapshot: jest.fn()
        .mockResolvedValueOnce({
          ok: true,
          snapshot: threadSnapshotFixture(),
        })
        .mockImplementationOnce(() => resumeRefresh.promise),
      subscribeCodingAgentThreadEvents: jest.fn().mockResolvedValue({ detach }),
    };
    useGatewayMock.mockReturnValue(gatewayContext({
      client: client as unknown as GatewayClient,
      connectionState: "connected",
    }));

    const rendered = render(<AgentThreadRoute />);

    expect(await screen.findByText("Repair mobile route")).toBeTruthy();
    await waitFor(() => {
      expect(client.subscribeCodingAgentThreadEvents).toHaveBeenCalledTimes(1);
    });
    await act(async () => {
      appStateChange?.("active");
    });
    rendered.unmount();

    await act(async () => {
      resumeRefresh.resolve({ ok: true, snapshot: threadSnapshotFixture() });
      await resumeRefresh.promise;
    });

    expect(client.subscribeCodingAgentThreadEvents).toHaveBeenCalledTimes(1);
    addEventListenerSpy.mockRestore();
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
