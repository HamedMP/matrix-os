jest.mock("@/app/_layout", () => ({
  useGateway: jest.fn(),
}));

jest.mock("@/lib/feature-flags", () => ({
  CODING_AGENTS_MOBILE_WORKSPACE: true,
}));

jest.mock("@react-native-async-storage/async-storage", () => ({
  getItem: jest.fn(),
  setItem: jest.fn(),
}));

const mockRouterPush = jest.fn();
const mockSearchParams: { reviewId?: string | string[] } = {};

jest.mock("expo-router", () => ({
  useLocalSearchParams: () => mockSearchParams,
  useRouter: () => ({
    push: mockRouterPush,
  }),
}));

import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Linking } from "react-native";
import AgentsScreen from "../app/agents";
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

function summaryFixture({
  threadCreate = false,
  files = false,
  sourceControl = false,
}: { threadCreate?: boolean; files?: boolean; sourceControl?: boolean } = {}) {
  return {
    runtime: {
      id: "rt_primary",
      label: "Primary",
      status: "available",
    },
    capabilities: [
      {
        id: "codingAgentsRuntimeSummary",
        enabled: true,
      },
      {
        id: "codingAgentsReview",
        enabled: true,
      },
      ...(threadCreate ? [{
        id: "codingAgentsThreadCreate",
        enabled: true,
      }] : []),
      ...(files ? [{
        id: "codingAgentsFiles",
        enabled: true,
      }] : []),
      ...(sourceControl ? [{
        id: "codingAgentsSourceControl",
        enabled: true,
      }] : []),
    ],
    providers: [
      {
        id: "codex",
        kind: "codex",
        displayName: "Codex",
        availability: "available",
        installStatus: "installed",
        authStatus: "authenticated",
        supportedModes: ["default"],
        defaultMode: "default",
        setupActions: [],
      },
    ],
    projects: { items: [], hasMore: false, limit: 20 },
    activeThreads: {
      items: [
        {
          id: "thread_mobile",
          providerId: "codex",
          title: "Repair mobile route",
          status: "running",
          createdAt: "2026-07-06T00:00:00.000Z",
          updatedAt: "2026-07-06T00:01:00.000Z",
        },
      ],
      hasMore: false,
      limit: 20,
    },
    attentionThreads: { items: [], hasMore: false, limit: 20 },
    terminalSessions: {
      items: [
        {
          id: "matrix-abc1234",
          name: "matrix-abc1234",
          status: "running",
          attachable: true,
          createdAt: "2026-07-06T00:00:00.000Z",
          updatedAt: "2026-07-06T00:01:00.000Z",
        },
      ],
      hasMore: false,
      limit: 20,
    },
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

function attentionSummaryFixture() {
  const summary = summaryFixture();
  return {
    ...summary,
    activeThreads: {
      ...summary.activeThreads,
      items: [
        {
          ...summary.activeThreads.items[0],
          id: "thread_approval",
          title: "Approve deployment",
          status: "waiting_for_approval",
          attention: "approval_required",
        },
        {
          ...summary.activeThreads.items[0],
          id: "thread_input",
          title: "Clarify test target",
          status: "waiting_for_input",
          attention: "input_required",
        },
        {
          ...summary.activeThreads.items[0],
          id: "thread_failed",
          title: "Repair failing run",
          status: "failed",
          attention: "failed",
        },
      ],
    },
  };
}

function attentionOnlySummaryFixture() {
  const summary = summaryFixture();
  return {
    ...summary,
    activeThreads: {
      ...summary.activeThreads,
      items: [],
    },
    attentionThreads: {
      items: [
        {
          ...summary.activeThreads.items[0],
          id: "thread_approval",
          title: "Approve deployment",
          status: "waiting_for_approval",
          attention: "approval_required",
        },
        {
          ...summary.activeThreads.items[0],
          id: "thread_failed",
          title: "Repair failed run",
          status: "failed",
          attention: "failed",
        },
      ],
      hasMore: false,
      limit: 20,
    },
  };
}

function recentWorkSummaryFixture() {
  const summary = summaryFixture({ threadCreate: true });
  const approvalThread = {
    ...summary.activeThreads.items[0],
    id: "thread_approval",
    title: "Approve deploy plan",
    status: "waiting_for_approval",
    attention: "approval_required",
    updatedAt: "2026-07-06T00:02:00.000Z",
  };

  return {
    ...summary,
    activeThreads: {
      ...summary.activeThreads,
      items: [
        {
          ...summary.activeThreads.items[0],
          id: "thread_newer_running",
          title: "Newer running task",
          status: "running",
          updatedAt: "2026-07-06T00:10:00.000Z",
        },
      ],
    },
    attentionThreads: {
      items: [approvalThread],
      hasMore: false,
      limit: 20,
    },
    terminalSessions: {
      ...summary.terminalSessions,
      items: [
        {
          ...summary.terminalSessions.items[0],
          id: "matrix-newer",
          name: "matrix-newer",
          status: "running",
          attachable: true,
          updatedAt: "2026-07-06T00:11:00.000Z",
        },
      ],
    },
  };
}

function providerSetupSummaryFixture() {
  const summary = summaryFixture();
  return {
    ...summary,
    providers: [
      {
        ...summary.providers[0],
        id: "codex",
        displayName: "Codex",
        availability: "auth_required",
        installStatus: "installed",
        authStatus: "missing",
        setupActions: [
          {
            id: "codex",
            kind: "foreground_terminal",
            label: "Sign in from Terminal",
            command: "codex login --api-key ghp_should_not_render_secret",
          },
        ],
      },
      {
        ...summary.providers[0],
        id: "claude",
        kind: "claude",
        displayName: "Claude Code",
        availability: "setup_required",
        installStatus: "missing",
        authStatus: "unknown",
        setupActions: [
          {
            id: "claude",
            kind: "open_settings",
            label: "Open agent settings",
          },
        ],
      },
    ],
  };
}

function previewSummaryFixture() {
  const summary = summaryFixture();
  return {
    ...summary,
    capabilities: [
      ...summary.capabilities,
      {
        id: "codingAgentsPreview",
        enabled: true,
      },
    ],
    previewSessions: {
      items: [
        {
          id: "prev_mobile_local",
          label: "Mobile app preview",
          status: "running",
          origin: "http://localhost:8081",
          updatedAt: "2026-07-06T00:04:00.000Z",
        },
        {
          id: "prev_mobile_internal",
          label: "Internal preview",
          status: "starting",
          updatedAt: "2026-07-06T00:03:00.000Z",
        },
        {
          id: "prev_mobile_secure",
          label: "Secure mobile preview",
          status: "running",
          origin: "https://preview.matrix-os.test",
          updatedAt: "2026-07-06T00:05:00.000Z",
        },
      ],
      hasMore: false,
      limit: 50,
    },
  };
}

function reviewsFixture() {
  return {
    items: [
      {
        id: "rev_mobile_1",
        projectId: "matrix-os",
        worktreeId: "wt_mobile_1",
        status: "reviewing",
        pullRequestNumber: 759,
        round: 2,
        maxRounds: 3,
        reviewer: "matrix-reviewer",
        implementer: "matrix-implementer",
        findings: {
          total: 2,
          high: 1,
          medium: 1,
          low: 0,
        },
        updatedAt: "2026-07-06T00:02:00.000Z",
      },
    ],
    hasMore: false,
    limit: 50,
  };
}

function reviewSnapshotFixture() {
  return {
    review: reviewsFixture().items[0],
    files: {
      items: [
        {
          path: "packages/gateway/src/coding-agents/routes.ts",
          status: "modified",
          additions: 0,
          deletions: 0,
          partial: true,
          hunks: [],
          findings: [
            {
              id: "HIGH-1",
              severity: "high",
              line: 42,
              summary: "Validate ownership before returning snapshots.",
            },
          ],
        },
      ],
      hasMore: false,
      limit: 100,
    },
    partial: true,
    safeNotice: "Diff content is not available yet. Showing bounded review findings.",
    updatedAt: "2026-07-06T00:02:00.000Z",
  };
}

function reviewsWithTwoWorktreesFixture() {
  return {
    ...reviewsFixture(),
    items: [
      reviewsFixture().items[0],
      {
        ...reviewsFixture().items[0],
        id: "rev_mobile_2",
        worktreeId: "wt_mobile_2",
        pullRequestNumber: 760,
        updatedAt: "2026-07-06T00:05:00.000Z",
      },
    ],
  };
}

function reviewSnapshotForSecondWorktreeFixture() {
  return {
    ...reviewSnapshotFixture(),
    review: reviewsWithTwoWorktreesFixture().items[1],
    updatedAt: "2026-07-06T00:05:00.000Z",
  };
}

function reviewSnapshotWithUnsafeFilePathFixture() {
  const snapshot = reviewSnapshotFixture();
  return {
    ...snapshot,
    files: {
      ...snapshot.files,
      items: snapshot.files.items.map((file) => ({
        ...file,
        path: "src/sk_live_1234567890abcdefghi.ts",
      })),
    },
  };
}

function fileReadFixture() {
  return {
    metadata: {
      path: "packages/gateway/src/coding-agents/routes.ts",
      kind: "file",
      sizeBytes: 37,
      etag: "sha256_mobile_file",
      updatedAt: "2026-07-06T00:03:00.000Z",
    },
    content: "export const safeRoute = true;\n",
    encoding: "utf8",
    truncated: false,
    limitBytes: 65536,
  };
}

function fileWriteFixture() {
  return {
    metadata: {
      path: "packages/gateway/src/coding-agents/routes.ts",
      kind: "file",
      sizeBytes: 38,
      etag: "sha256_mobile_file_next",
      updatedAt: "2026-07-06T00:04:00.000Z",
    },
    encoding: "utf8",
    writtenBytes: 38,
  };
}

function reviewSnapshotWithFinding(summary: string) {
  const snapshot = reviewSnapshotFixture();
  return {
    ...snapshot,
    files: {
      ...snapshot.files,
      items: snapshot.files.items.map((file) => ({
        ...file,
        findings: file.findings?.map((finding) => ({
          ...finding,
          summary,
        })),
      })),
    },
  };
}

function reviewSnapshotWithHunks() {
  const snapshot = reviewSnapshotFixture();
  return {
    ...snapshot,
    files: {
      ...snapshot.files,
      items: snapshot.files.items.map((file) => ({
        ...file,
        additions: 12,
        deletions: 4,
        hunks: [
          {
            id: "hunk_rev_mobile_1_0_0",
            oldStart: 42,
            oldLines: 3,
            newStart: 45,
            newLines: 5,
            partial: true,
          },
          {
            id: "hunk_rev_mobile_1_0_1",
            oldStart: 88,
            oldLines: 1,
            newStart: 93,
            newLines: 2,
            partial: false,
            lines: [
              {
                kind: "context",
                oldLine: 88,
                newLine: 93,
                content: "const request = parseReviewRequest(input);",
              },
              {
                kind: "remove",
                oldLine: 89,
                content: "return rawReviewDetails;",
              },
              {
                kind: "add",
                newLine: 94,
                content: "return safeReviewDetails;",
              },
            ],
          },
        ],
      })),
    },
  };
}

function reviewSnapshotWithChangedHunks() {
  const snapshot = reviewSnapshotWithHunks();
  return {
    ...snapshot,
    files: {
      ...snapshot.files,
      items: snapshot.files.items.map((file) => ({
        ...file,
        hunks: file.hunks.map((hunk, hunkIndex) => hunkIndex === 1
          ? {
              ...hunk,
              oldStart: 120,
              oldLines: 4,
              newStart: 130,
              newLines: 6,
            }
          : hunk),
      })),
    },
    updatedAt: "2026-07-06T00:04:00.000Z",
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

describe("AgentsScreen", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete mockSearchParams.reviewId;
    jest.mocked(AsyncStorage.getItem).mockResolvedValue(null);
    jest.mocked(AsyncStorage.setItem).mockResolvedValue();
  });

  it("renders provider, thread, and terminal summaries", async () => {
    const client = {
      getCodingAgentRuntimeSummary: jest.fn().mockResolvedValue({
        ok: true,
        summary: summaryFixture(),
      }),
      getCodingAgentReviews: jest.fn().mockResolvedValue({
        ok: true,
        reviews: reviewsFixture(),
      }),
    };
    useGatewayMock.mockReturnValue(gatewayContext({
      client: client as unknown as GatewayClient,
      connectionState: "connected",
    }));

    render(<AgentsScreen />);

    expect(screen.getByText("Loading workspace...")).toBeTruthy();
    await screen.findByText("Codex");
    expect(screen.getAllByText("Repair mobile route").length).toBeGreaterThan(0);
    expect(screen.getAllByText("matrix-abc1234").length).toBeGreaterThan(0);
  });

  it("shows an agent workspace offline banner without hiding the hydrated summary", async () => {
    const client = {
      getCodingAgentRuntimeSummary: jest.fn().mockResolvedValue({
        ok: true,
        summary: summaryFixture(),
      }),
      getCodingAgentReviews: jest.fn().mockResolvedValue({
        ok: true,
        reviews: reviewsFixture(),
      }),
    };
    useGatewayMock.mockReturnValue(gatewayContext({
      client: client as unknown as GatewayClient,
      connectionState: "disconnected",
    }));

    render(<AgentsScreen />);

    expect(await screen.findByText("Agent workspace offline")).toBeTruthy();
    expect(screen.getAllByText("Repair mobile route").length).toBeGreaterThan(0);
    expect(screen.queryByText(/token|bearer|secret|\/home\/matrix/i)).toBeNull();
  });

  it("offers a safe reconnect action from the agent workspace banner", async () => {
    const connect = jest.fn();
    const client = {
      connect,
      getCodingAgentRuntimeSummary: jest.fn().mockResolvedValue({
        ok: true,
        summary: summaryFixture(),
      }),
      getCodingAgentReviews: jest.fn().mockResolvedValue({
        ok: true,
        reviews: reviewsFixture(),
      }),
    };
    useGatewayMock.mockReturnValue(gatewayContext({
      client: client as unknown as GatewayClient,
      connectionState: "error",
    }));

    render(<AgentsScreen />);

    expect(await screen.findByText("Agent workspace reconnecting")).toBeTruthy();
    await act(async () => {
      fireEvent.press(screen.getByText("Retry"));
    });

    expect(connect).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/token|bearer|secret|\/home\/matrix/i)).toBeNull();
  });

  it("hydrates and updates notification preferences", async () => {
    const client = {
      getCodingAgentRuntimeSummary: jest.fn().mockResolvedValue({
        ok: true,
        summary: summaryFixture(),
      }),
      getCodingAgentReviews: jest.fn().mockResolvedValue({
        ok: true,
        reviews: reviewsFixture(),
      }),
      getCodingAgentNotificationPreferences: jest.fn()
        .mockResolvedValueOnce({
          ok: true,
          preferences: { attentionPush: { approval: true, input: true, failed: false } },
        })
        .mockResolvedValueOnce({
          ok: true,
          preferences: { attentionPush: { approval: false, input: true, failed: false } },
        }),
      updateCodingAgentNotificationPreferences: jest.fn().mockResolvedValue({
        ok: true,
        preferences: { attentionPush: { approval: false, input: true, failed: true } },
      }),
    };
    useGatewayMock.mockReturnValue(gatewayContext({
      client: client as unknown as GatewayClient,
      connectionState: "connected",
    }));

    render(<AgentsScreen />);

    const failedSwitch = await screen.findByRole("switch", { name: "Failed run alerts" });
    expect(failedSwitch.props.value).toBe(false);

    fireEvent(failedSwitch, "valueChange", true);

    await waitFor(() => {
      expect(client.updateCodingAgentNotificationPreferences).toHaveBeenCalledWith({
        attentionPush: { approval: false, input: true, failed: true },
      });
    });
    expect((await screen.findByRole("switch", { name: "Failed run alerts" })).props.value).toBe(true);
    expect(screen.queryByText(/token|bearer|secret|\/home\/matrix/i)).toBeNull();
  });

  it("opens a mobile thread detail route from active threads", async () => {
    const client = {
      getCodingAgentRuntimeSummary: jest.fn().mockResolvedValue({
        ok: true,
        summary: summaryFixture(),
      }),
      getCodingAgentReviews: jest.fn().mockResolvedValue({
        ok: true,
        reviews: reviewsFixture(),
      }),
    };
    useGatewayMock.mockReturnValue(gatewayContext({
      client: client as unknown as GatewayClient,
      connectionState: "connected",
    }));

    render(<AgentsScreen />);

    await screen.findAllByText("Repair mobile route");
    await act(async () => {
      fireEvent.press(screen.getByLabelText("Open thread Repair mobile route"));
    });

    expect(mockRouterPush).toHaveBeenCalledWith("/agents/thread_mobile");
  });

  it("renders reachable in-app attention badges for active coding-agent threads", async () => {
    const client = {
      getCodingAgentRuntimeSummary: jest.fn().mockResolvedValue({
        ok: true,
        summary: attentionSummaryFixture(),
      }),
      getCodingAgentReviews: jest.fn().mockResolvedValue({
        ok: true,
        reviews: reviewsFixture(),
      }),
    };
    useGatewayMock.mockReturnValue(gatewayContext({
      client: client as unknown as GatewayClient,
      connectionState: "connected",
    }));

    render(<AgentsScreen />);

    expect((await screen.findAllByText("Approve deployment")).length).toBeGreaterThan(0);
    expect(screen.getAllByText("Approval needed").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Input needed").length).toBeGreaterThan(0);
    expect(screen.getByLabelText("Open thread Approve deployment, Approval needed")).toBeTruthy();
    expect(screen.getByLabelText("Open thread Clarify test target, Input needed")).toBeTruthy();
    expect(screen.getByLabelText("Open thread Repair failing run")).toBeTruthy();
    expect(screen.queryByText("Run failed")).toBeNull();
    expect(screen.queryByText(/home\/matrix|token|secret|stack trace/i)).toBeNull();
  });

  it("renders gateway-owned attention threads separately from active threads", async () => {
    const client = {
      getCodingAgentRuntimeSummary: jest.fn().mockResolvedValue({
        ok: true,
        summary: attentionOnlySummaryFixture(),
      }),
      getCodingAgentReviews: jest.fn().mockResolvedValue({
        ok: true,
        reviews: reviewsFixture(),
      }),
    };
    useGatewayMock.mockReturnValue(gatewayContext({
      client: client as unknown as GatewayClient,
      connectionState: "connected",
    }));

    render(<AgentsScreen />);

    expect(await screen.findByText("Needs Attention")).toBeTruthy();
    expect(screen.getAllByText("Approve deployment").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Repair failed run").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Approval needed").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Failed").length).toBeGreaterThan(0);
    expect(screen.getByText("No active threads.")).toBeTruthy();

    await act(async () => {
      fireEvent.press(screen.getByLabelText("Open attention thread Repair failed run, Failed"));
    });
    expect(mockRouterPush).toHaveBeenCalledWith("/agents/thread_failed");
  });

  it("prioritizes pending approval recent work before active runs and terminals", async () => {
    const client = {
      getCodingAgentRuntimeSummary: jest.fn().mockResolvedValue({
        ok: true,
        summary: recentWorkSummaryFixture(),
      }),
      getCodingAgentReviews: jest.fn().mockResolvedValue({
        ok: true,
        reviews: reviewsFixture(),
      }),
    };
    useGatewayMock.mockReturnValue(gatewayContext({
      client: client as unknown as GatewayClient,
      connectionState: "connected",
    }));

    render(<AgentsScreen />);

    await screen.findByText("Recent Work");
    expect(screen.getByLabelText("Open recent work Approve deploy plan, Approval needed")).toBeTruthy();
    expect(screen.getByLabelText("Open recent work Newer running task")).toBeTruthy();
    expect(screen.getByLabelText("Open recent terminal matrix-newer")).toBeTruthy();

    const buttonOrder = screen.getAllByRole("button").map((node) => node.props.accessibilityLabel);
    expect(buttonOrder.indexOf("Open recent work Approve deploy plan, Approval needed"))
      .toBeLessThan(buttonOrder.indexOf("Open recent work Newer running task"));
    expect(buttonOrder.indexOf("Open recent work Newer running task"))
      .toBeLessThan(buttonOrder.indexOf("Open recent terminal matrix-newer"));

    await act(async () => {
      fireEvent.press(screen.getByLabelText("Open recent terminal matrix-newer"));
    });
    expect(AsyncStorage.setItem).toHaveBeenCalledWith(
      MOBILE_SHELL_STATE_STORAGE_KEY,
      expect.stringContaining("\"lastActiveTerminalSessionId\":\"matrix-newer\""),
    );
    expect(mockRouterPush).toHaveBeenCalledWith("/terminal");

    await act(async () => {
      fireEvent.press(screen.getByLabelText("Start a new coding-agent run"));
    });
    expect(mockRouterPush).toHaveBeenCalledWith("/agents/new");
  });

  it("keeps a terminal resume row when active threads fill recent work", async () => {
    const summary = summaryFixture();
    const client = {
      getCodingAgentRuntimeSummary: jest.fn().mockResolvedValue({
        ok: true,
        summary: {
          ...summary,
          activeThreads: {
            ...summary.activeThreads,
            items: Array.from({ length: 7 }, (_, index) => ({
              ...summary.activeThreads.items[0],
              id: `thread_recent_${index}`,
              title: `Active task ${index}`,
              status: "running",
              updatedAt: `2026-07-06T00:0${index}:00.000Z`,
            })),
          },
        },
      }),
      getCodingAgentReviews: jest.fn().mockResolvedValue({
        ok: true,
        reviews: reviewsFixture(),
      }),
    };
    useGatewayMock.mockReturnValue(gatewayContext({
      client: client as unknown as GatewayClient,
      connectionState: "connected",
    }));

    render(<AgentsScreen />);

    await screen.findByText("Recent Work");
    expect(screen.getByLabelText("Open recent terminal matrix-abc1234")).toBeTruthy();
    expect(screen.queryByLabelText("Open recent work Active task 1")).toBeNull();
  });

  it("surfaces safe provider setup warnings without rendering setup commands", async () => {
    const client = {
      getCodingAgentRuntimeSummary: jest.fn().mockResolvedValue({
        ok: true,
        summary: providerSetupSummaryFixture(),
      }),
      getCodingAgentReviews: jest.fn().mockResolvedValue({
        ok: true,
        reviews: reviewsFixture(),
      }),
    };
    useGatewayMock.mockReturnValue(gatewayContext({
      client: client as unknown as GatewayClient,
      connectionState: "connected",
    }));

    render(<AgentsScreen />);

    await screen.findByText("Provider Setup");
    expect(screen.getByText("Sign in from Terminal")).toBeTruthy();
    expect(screen.getByText("Open agent settings")).toBeTruthy();
    expect(screen.getByLabelText("Provider setup needed for Codex, auth required")).toBeTruthy();
    expect(screen.getByLabelText("Provider setup needed for Claude Code, setup required")).toBeTruthy();
    expect(screen.queryByText(/codex login|api-key|ghp_should_not_render_secret/i)).toBeNull();
  });

  it("does not show setup warnings for ready or non-actionable provider states", async () => {
    const summary = summaryFixture();
    const client = {
      getCodingAgentRuntimeSummary: jest.fn().mockResolvedValue({
        ok: true,
        summary: {
          ...summary,
          providers: [
            {
              ...summary.providers[0],
              id: "ready-with-action",
              displayName: "Ready Provider",
              availability: "available",
              installStatus: "installed",
              authStatus: "authenticated",
              setupActions: [
                {
                  id: "ready-with-action",
                  kind: "open_settings",
                  label: "Optional settings",
                },
              ],
            },
            {
              ...summary.providers[0],
              id: "unknown-provider",
              displayName: "Unknown Provider",
              availability: "unknown",
              installStatus: "unknown",
              authStatus: "unknown",
              setupActions: [],
            },
          ],
        },
      }),
      getCodingAgentReviews: jest.fn().mockResolvedValue({
        ok: true,
        reviews: reviewsFixture(),
      }),
    };
    useGatewayMock.mockReturnValue(gatewayContext({
      client: client as unknown as GatewayClient,
      connectionState: "connected",
    }));

    render(<AgentsScreen />);

    await screen.findByText("Providers");
    expect(screen.queryByText("Provider Setup")).toBeNull();
    expect(screen.queryByLabelText(/Provider setup needed for Ready Provider/i)).toBeNull();
    expect(screen.queryByLabelText(/Provider setup needed for Unknown Provider/i)).toBeNull();
    expect(screen.queryByText("Optional settings")).toBeNull();
  });

  it("renders read-only preview summaries without unsafe origin details", async () => {
    const client = {
      getCodingAgentRuntimeSummary: jest.fn().mockResolvedValue({
        ok: true,
        summary: previewSummaryFixture(),
      }),
      getCodingAgentReviews: jest.fn().mockResolvedValue({
        ok: true,
        reviews: reviewsFixture(),
      }),
    };
    useGatewayMock.mockReturnValue(gatewayContext({
      client: client as unknown as GatewayClient,
      connectionState: "connected",
    }));

    render(<AgentsScreen />);

    expect(await screen.findByText("Previews")).toBeTruthy();
    expect(screen.getByText("Mobile app preview")).toBeTruthy();
    expect(screen.getByText("http://localhost:8081")).toBeTruthy();
    expect(screen.getByText("Internal preview")).toBeTruthy();
    expect(screen.getByText("No local origin")).toBeTruthy();
    expect(screen.queryByText(/internal\.preview|token=secret|\/home\/matrix/i)).toBeNull();
  });

  it("opens mobile preview rows through a bounded preview route", async () => {
    const client = {
      getCodingAgentRuntimeSummary: jest.fn().mockResolvedValue({
        ok: true,
        summary: previewSummaryFixture(),
      }),
      getCodingAgentReviews: jest.fn().mockResolvedValue({
        ok: true,
        reviews: reviewsFixture(),
      }),
    };
    useGatewayMock.mockReturnValue(gatewayContext({
      client: client as unknown as GatewayClient,
      connectionState: "connected",
    }));

    render(<AgentsScreen />);

    const previewButton = await screen.findByLabelText("Open preview Secure mobile preview");
    await act(async () => {
      fireEvent.press(previewButton);
    });

    expect(mockRouterPush).toHaveBeenCalledWith({
      pathname: "/agents/preview",
      params: {
        id: "prev_mobile_secure",
      },
    });
  });

  it("renders read-only review summaries", async () => {
    const client = {
      getCodingAgentRuntimeSummary: jest.fn().mockResolvedValue({
        ok: true,
        summary: summaryFixture(),
      }),
      getCodingAgentReviews: jest.fn().mockResolvedValue({
        ok: true,
        reviews: reviewsFixture(),
      }),
    };
    useGatewayMock.mockReturnValue(gatewayContext({
      client: client as unknown as GatewayClient,
      connectionState: "connected",
    }));

    render(<AgentsScreen />);

    await screen.findByText("Review");
    expect(screen.getByText("matrix-os")).toBeTruthy();
    expect(screen.getByText(/PR #759/)).toBeTruthy();
    expect(screen.getByText(/Round 2 of 3/)).toBeTruthy();
    expect(screen.getByText("1 high")).toBeTruthy();
    expect(client.getCodingAgentReviews).toHaveBeenCalledWith();
  });

  it("loads a read-only review snapshot when a review is selected", async () => {
    const client = {
      getCodingAgentRuntimeSummary: jest.fn().mockResolvedValue({
        ok: true,
        summary: summaryFixture(),
      }),
      getCodingAgentReviews: jest.fn().mockResolvedValue({
        ok: true,
        reviews: reviewsFixture(),
      }),
      getCodingAgentReviewSnapshot: jest.fn().mockResolvedValue({
        ok: true,
        snapshot: reviewSnapshotFixture(),
      }),
    };
    useGatewayMock.mockReturnValue(gatewayContext({
      client: client as unknown as GatewayClient,
      connectionState: "connected",
    }));

    render(<AgentsScreen />);

    await screen.findByLabelText("Open review PR #759");
    await act(async () => {
      fireEvent.press(screen.getByLabelText("Open review PR #759"));
    });

    expect(client.getCodingAgentReviewSnapshot).toHaveBeenCalledWith({ reviewId: "rev_mobile_1" });
    expect(await screen.findByText("packages/gateway/src/coding-agents/routes.ts")).toBeTruthy();
    expect(screen.getByText("Validate ownership before returning snapshots.")).toBeTruthy();
    expect(screen.getByText("Diff content is not available yet. Showing bounded review findings.")).toBeTruthy();
    expect(screen.queryByText(/home\/matrix|token|secret/i)).toBeNull();
  });

  it("hydrates a routed review snapshot from a bounded review id", async () => {
    mockSearchParams.reviewId = "rev_mobile_2";
    const client = {
      getCodingAgentRuntimeSummary: jest.fn().mockResolvedValue({
        ok: true,
        summary: summaryFixture(),
      }),
      getCodingAgentReviews: jest.fn().mockResolvedValue({
        ok: true,
        reviews: reviewsWithTwoWorktreesFixture(),
      }),
      getCodingAgentReviewSnapshot: jest.fn(({ reviewId }: { reviewId: string }) => Promise.resolve({
        ok: true,
        snapshot: reviewId === "rev_mobile_2" ? reviewSnapshotForSecondWorktreeFixture() : reviewSnapshotFixture(),
      })),
    };
    useGatewayMock.mockReturnValue(gatewayContext({
      client: client as unknown as GatewayClient,
      connectionState: "connected",
    }));

    render(<AgentsScreen />);

    expect(await screen.findByText("Review")).toBeTruthy();
    await waitFor(() => {
      expect(client.getCodingAgentReviewSnapshot).toHaveBeenCalledWith({ reviewId: "rev_mobile_2" });
    });
    expect(await screen.findByText("PR #760 review details")).toBeTruthy();
    expect(screen.queryByText(/home\/matrix|token|secret/i)).toBeNull();
  });

  it("ignores invalid routed review ids", async () => {
    mockSearchParams.reviewId = "/home/matrix/token_sk_live_123";
    const client = {
      getCodingAgentRuntimeSummary: jest.fn().mockResolvedValue({
        ok: true,
        summary: summaryFixture(),
      }),
      getCodingAgentReviews: jest.fn().mockResolvedValue({
        ok: true,
        reviews: reviewsFixture(),
      }),
      getCodingAgentReviewSnapshot: jest.fn().mockResolvedValue({
        ok: true,
        snapshot: reviewSnapshotFixture(),
      }),
    };
    useGatewayMock.mockReturnValue(gatewayContext({
      client: client as unknown as GatewayClient,
      connectionState: "connected",
    }));

    render(<AgentsScreen />);

    expect(await screen.findByText("Review")).toBeTruthy();
    await waitFor(() => {
      expect(client.getCodingAgentReviews).toHaveBeenCalledWith();
    });
    expect(client.getCodingAgentReviewSnapshot).not.toHaveBeenCalled();
    expect(screen.queryByText(/home\/matrix|token|secret/i)).toBeNull();
  });

  it("loads bounded file content from the gateway when a review file is selected", async () => {
    const client = {
      getCodingAgentRuntimeSummary: jest.fn().mockResolvedValue({
        ok: true,
        summary: summaryFixture({ files: true }),
      }),
      getCodingAgentReviews: jest.fn().mockResolvedValue({
        ok: true,
        reviews: reviewsFixture(),
      }),
      getCodingAgentReviewSnapshot: jest.fn().mockResolvedValue({
        ok: true,
        snapshot: reviewSnapshotFixture(),
      }),
      getCodingAgentFileContent: jest.fn().mockResolvedValue({
        ok: true,
        file: fileReadFixture(),
      }),
    };
    useGatewayMock.mockReturnValue(gatewayContext({
      client: client as unknown as GatewayClient,
      connectionState: "connected",
    }));

    render(<AgentsScreen />);

    await screen.findByLabelText("Open review PR #759");
    await act(async () => {
      fireEvent.press(screen.getByLabelText("Open review PR #759"));
    });
    await screen.findByText("packages/gateway/src/coding-agents/routes.ts");
    await act(async () => {
      fireEvent.press(screen.getByLabelText("Open file packages/gateway/src/coding-agents/routes.ts"));
    });

    expect(client.getCodingAgentFileContent).toHaveBeenCalledWith({
      projectId: "matrix-os",
      worktreeId: "wt_mobile_1",
      path: "packages/gateway/src/coding-agents/routes.ts",
    });
    expect(await screen.findByDisplayValue("export const safeRoute = true;\n")).toBeTruthy();
    expect(screen.queryByText(/home\/matrix|token|secret/i)).toBeNull();
  });

  it("browses and searches review workspace files through the mobile gateway client", async () => {
    const browse = {
      directory: {
        path: "packages",
        kind: "directory",
        updatedAt: "2026-07-06T00:03:00.000Z",
      },
      entries: {
        items: [
          {
            path: "packages/gateway",
            kind: "directory",
            updatedAt: "2026-07-06T00:03:00.000Z",
          },
          {
            path: "packages/README.md",
            kind: "file",
            sizeBytes: 24,
            updatedAt: "2026-07-06T00:03:00.000Z",
          },
        ],
        hasMore: false,
        limit: 20,
      },
    };
    const search = {
      matches: {
        items: [
          {
            path: "packages/gateway/src/coding-agents/routes.ts",
            kind: "file",
            sizeBytes: 37,
            updatedAt: "2026-07-06T00:03:00.000Z",
          },
        ],
        hasMore: false,
        limit: 20,
      },
    };
    const client = {
      getCodingAgentRuntimeSummary: jest.fn().mockResolvedValue({
        ok: true,
        summary: summaryFixture({ files: true }),
      }),
      getCodingAgentReviews: jest.fn().mockResolvedValue({
        ok: true,
        reviews: reviewsFixture(),
      }),
      getCodingAgentReviewSnapshot: jest.fn().mockResolvedValue({
        ok: true,
        snapshot: reviewSnapshotFixture(),
      }),
      browseCodingAgentFiles: jest.fn().mockResolvedValue({
        ok: true,
        browse,
      }),
      searchCodingAgentFiles: jest.fn().mockResolvedValue({
        ok: true,
        search,
      }),
      getCodingAgentFileContent: jest.fn().mockResolvedValue({
        ok: true,
        file: fileReadFixture(),
      }),
    };
    useGatewayMock.mockReturnValue(gatewayContext({
      client: client as unknown as GatewayClient,
      connectionState: "connected",
    }));

    render(<AgentsScreen />);

    await screen.findByLabelText("Open review PR #759");
    await act(async () => {
      fireEvent.press(screen.getByLabelText("Open review PR #759"));
    });
    await screen.findByText("PR #759 review details");
    await act(async () => {
      fireEvent.press(screen.getByLabelText("Browse workspace files for review PR #759"));
    });

    expect(await screen.findByText("packages/gateway")).toBeTruthy();
    expect(client.browseCodingAgentFiles).toHaveBeenCalledWith({
      projectId: "matrix-os",
      worktreeId: "wt_mobile_1",
      limit: 20,
    });

    await act(async () => {
      fireEvent.changeText(screen.getByLabelText("Search review workspace files"), "routes");
    });
    await act(async () => {
      fireEvent.press(screen.getByLabelText("Run review workspace file search"));
    });

    expect((await screen.findAllByText("packages/gateway/src/coding-agents/routes.ts")).length).toBeGreaterThanOrEqual(2);
    expect(client.searchCodingAgentFiles).toHaveBeenCalledWith({
      projectId: "matrix-os",
      worktreeId: "wt_mobile_1",
      query: "routes",
      limit: 20,
    });
    await act(async () => {
      fireEvent.press(screen.getByLabelText("Open file packages/gateway/src/coding-agents/routes.ts from search results"));
    });
    expect(client.getCodingAgentFileContent).toHaveBeenCalledWith({
      projectId: "matrix-os",
      worktreeId: "wt_mobile_1",
      path: "packages/gateway/src/coding-agents/routes.ts",
    });
    expect(screen.queryByText(/home\/matrix|token|secret/i)).toBeNull();
  });

  it("saves edited file content through the mobile gateway client without exposing credentials", async () => {
    const client = {
      getCodingAgentRuntimeSummary: jest.fn().mockResolvedValue({
        ok: true,
        summary: summaryFixture({ files: true }),
      }),
      getCodingAgentReviews: jest.fn().mockResolvedValue({
        ok: true,
        reviews: reviewsFixture(),
      }),
      getCodingAgentReviewSnapshot: jest.fn().mockResolvedValue({
        ok: true,
        snapshot: reviewSnapshotFixture(),
      }),
      getCodingAgentFileContent: jest.fn().mockResolvedValue({
        ok: true,
        file: fileReadFixture(),
      }),
      saveCodingAgentFileContent: jest.fn().mockResolvedValue({
        ok: true,
        file: fileWriteFixture(),
      }),
    };
    useGatewayMock.mockReturnValue(gatewayContext({
      client: client as unknown as GatewayClient,
      connectionState: "connected",
    }));

    render(<AgentsScreen />);

    await screen.findByText("matrix-os");
    await act(async () => {
      fireEvent.press(screen.getByLabelText("Open review PR #759"));
    });
    await screen.findByText("packages/gateway/src/coding-agents/routes.ts");
    await act(async () => {
      fireEvent.press(screen.getByLabelText("Open file packages/gateway/src/coding-agents/routes.ts"));
    });
    const editor = await screen.findByLabelText("Edit file packages/gateway/src/coding-agents/routes.ts");
    await act(async () => {
      fireEvent.changeText(editor, "export const safeRoute = false;\n");
    });
    await act(async () => {
      fireEvent.press(screen.getByLabelText("Save file packages/gateway/src/coding-agents/routes.ts"));
    });

    expect(client.saveCodingAgentFileContent).toHaveBeenCalledWith(expect.objectContaining({
      projectId: "matrix-os",
      worktreeId: "wt_mobile_1",
      path: "packages/gateway/src/coding-agents/routes.ts",
      content: "export const safeRoute = false;\n",
      encoding: "utf8",
      baseEtag: "sha256_mobile_file",
    }));
    const saveCall = client.saveCodingAgentFileContent.mock.calls[0]?.[0];
    expect(saveCall).toEqual(expect.objectContaining({
      clientRequestId: expect.stringMatching(/^req_mobile_/),
    }));
    expect(JSON.stringify(saveCall)).not.toMatch(/token|bearer|secret/i);
    expect(await screen.findByText("Saved")).toBeTruthy();
    expect(screen.getByDisplayValue("export const safeRoute = false;\n")).toBeTruthy();
    expect(screen.queryByText(/home\/matrix|token|secret/i)).toBeNull();
  });

  it("prepares a source-control commit for reviewed files through the mobile gateway client", async () => {
    const client = {
      getCodingAgentRuntimeSummary: jest.fn().mockResolvedValue({
        ok: true,
        summary: summaryFixture({ sourceControl: true }),
      }),
      getCodingAgentReviews: jest.fn().mockResolvedValue({
        ok: true,
        reviews: reviewsFixture(),
      }),
      getCodingAgentReviewSnapshot: jest.fn().mockResolvedValue({
        ok: true,
        snapshot: reviewSnapshotFixture(),
      }),
      prepareCodingAgentSourceCommit: jest.fn().mockResolvedValue({
        ok: true,
        commit: {
          status: "committed",
          commitSha: "0123456789abcdef0123456789abcdef01234567",
          branch: "feature/review-fix",
          changedFileCount: 1,
          safeMessage: "Changes were committed.",
        },
      }),
    };
    useGatewayMock.mockReturnValue(gatewayContext({
      client: client as unknown as GatewayClient,
      connectionState: "connected",
    }));

    render(<AgentsScreen />);

    await screen.findByText("matrix-os");
    await act(async () => {
      fireEvent.press(screen.getByLabelText("Open review PR #759"));
    });
    await screen.findByText("packages/gateway/src/coding-agents/routes.ts");
    await act(async () => {
      fireEvent.press(screen.getByLabelText("Prepare commit for review PR #759"));
    });

    expect(client.prepareCodingAgentSourceCommit).toHaveBeenCalledWith(expect.objectContaining({
      projectId: "matrix-os",
      worktreeId: "wt_mobile_1",
      paths: ["packages/gateway/src/coding-agents/routes.ts"],
    }));
    const commitCall = client.prepareCodingAgentSourceCommit.mock.calls[0]?.[0];
    expect(commitCall).toEqual(expect.objectContaining({
      message: expect.stringMatching(/review/i),
      clientRequestId: expect.stringMatching(/^req_mobile_/),
    }));
    expect(JSON.stringify(commitCall)).not.toMatch(/token|bearer|secret/i);
    expect(await screen.findByText("Commit prepared")).toBeTruthy();
    expect(screen.queryByText(/home\/matrix|token|secret/i)).toBeNull();
  });

  it("ignores stale mobile commit completions after another review opens the same worktree", async () => {
    const commitResult = deferred<{
      ok: true;
      commit: {
        status: "committed";
        commitSha: string;
        branch: string;
        changedFileCount: number;
        safeMessage: string;
      };
    }>();
    const secondReview = {
      ...reviewsFixture().items[0],
      id: "rev_mobile_2",
      pullRequestNumber: 760,
      updatedAt: "2026-07-06T00:05:00.000Z",
    };
    const reviews = {
      ...reviewsFixture(),
      items: [reviewsFixture().items[0], secondReview],
    };
    const secondSnapshot = {
      ...reviewSnapshotFixture(),
      review: secondReview,
      updatedAt: "2026-07-06T00:05:00.000Z",
    };

    const client = {
      getCodingAgentRuntimeSummary: jest.fn().mockResolvedValue({
        ok: true,
        summary: summaryFixture({ sourceControl: true }),
      }),
      getCodingAgentReviews: jest.fn().mockResolvedValue({
        ok: true,
        reviews,
      }),
      getCodingAgentReviewSnapshot: jest.fn(({ reviewId }: { reviewId: string }) => Promise.resolve({
        ok: true,
        snapshot: reviewId === "rev_mobile_2" ? secondSnapshot : reviewSnapshotFixture(),
      })),
      prepareCodingAgentSourceCommit: jest.fn(() => commitResult.promise),
    };
    useGatewayMock.mockReturnValue(gatewayContext({
      client: client as unknown as GatewayClient,
      connectionState: "connected",
    }));

    render(<AgentsScreen />);

    await screen.findByLabelText("Open review PR #759");
    await act(async () => {
      fireEvent.press(screen.getByLabelText("Open review PR #759"));
    });
    await screen.findByText("packages/gateway/src/coding-agents/routes.ts");
    await act(async () => {
      fireEvent.press(screen.getByLabelText("Prepare commit for review PR #759"));
    });
    await act(async () => {
      fireEvent.press(screen.getByLabelText("Open review PR #760"));
    });
    await screen.findByText("PR #760 review details");

    await act(async () => {
      commitResult.resolve({
        ok: true,
        commit: {
          status: "committed",
          commitSha: "0123456789abcdef0123456789abcdef01234567",
          branch: "feature/review-fix",
          changedFileCount: 1,
          safeMessage: "Changes were committed.",
        },
      });
      await commitResult.promise;
    });

    expect(screen.queryByText("Commit prepared")).toBeNull();
    expect(screen.queryByText(/Source commit could not be prepared/i)).toBeNull();
  });

  it("creates a source-control pull request for reviewed files through the mobile gateway client", async () => {
    const openURLSpy = jest.spyOn(Linking, "openURL").mockResolvedValue(undefined);
    const client = {
      getCodingAgentRuntimeSummary: jest.fn().mockResolvedValue({
        ok: true,
        summary: summaryFixture({ sourceControl: true }),
      }),
      getCodingAgentReviews: jest.fn().mockResolvedValue({
        ok: true,
        reviews: reviewsFixture(),
      }),
      getCodingAgentReviewSnapshot: jest.fn().mockResolvedValue({
        ok: true,
        snapshot: reviewSnapshotFixture(),
      }),
      createCodingAgentSourcePullRequest: jest.fn().mockResolvedValue({
        ok: true,
        pullRequest: {
          status: "created",
          number: 808,
          url: "https://github.com/HamedMP/matrix-os/pull/808",
          headBranch: "feature/review-fix",
          baseBranch: "main",
          safeMessage: "Pull request is ready for review.",
        },
      }),
    };
    useGatewayMock.mockReturnValue(gatewayContext({
      client: client as unknown as GatewayClient,
      connectionState: "connected",
    }));

    render(<AgentsScreen />);

    await screen.findByText("matrix-os");
    await act(async () => {
      fireEvent.press(screen.getByLabelText("Open review PR #759"));
    });
    await screen.findByText("packages/gateway/src/coding-agents/routes.ts");
    await act(async () => {
      fireEvent.press(screen.getByLabelText("Create pull request for review PR #759"));
    });

    expect(client.createCodingAgentSourcePullRequest).toHaveBeenCalledWith(expect.objectContaining({
      projectId: "matrix-os",
      worktreeId: "wt_mobile_1",
    }));
    const pullRequestCall = client.createCodingAgentSourcePullRequest.mock.calls[0]?.[0];
    expect(pullRequestCall).toEqual(expect.objectContaining({
      title: "fix: apply review updates for PR #759",
      body: "Review updates are ready.",
      clientRequestId: expect.stringMatching(/^req_mobile_/),
    }));
    expect(JSON.stringify(pullRequestCall)).not.toMatch(/token|bearer|secret/i);
    expect(await screen.findByText("Pull request ready")).toBeTruthy();
    await act(async () => {
      fireEvent.press(screen.getByLabelText("Open created pull request #808"));
    });
    expect(openURLSpy).toHaveBeenCalledWith("https://github.com/HamedMP/matrix-os/pull/808");
    expect(screen.queryByText(/home\/matrix|token|secret/i)).toBeNull();
  });

  it("ignores stale mobile pull request completions after another review opens the same worktree", async () => {
    const pullRequestResult = deferred<{
      ok: true;
      pullRequest: {
        status: "created";
        number: number;
        url: string;
        headBranch: string;
        baseBranch: string;
        safeMessage: string;
      };
    }>();
    const secondReview = {
      ...reviewsFixture().items[0],
      id: "rev_mobile_2",
      pullRequestNumber: 760,
      updatedAt: "2026-07-06T00:05:00.000Z",
    };
    const reviews = {
      ...reviewsFixture(),
      items: [reviewsFixture().items[0], secondReview],
    };
    const secondSnapshot = {
      ...reviewSnapshotFixture(),
      review: secondReview,
      updatedAt: "2026-07-06T00:05:00.000Z",
    };
    const client = {
      getCodingAgentRuntimeSummary: jest.fn().mockResolvedValue({
        ok: true,
        summary: summaryFixture({ sourceControl: true }),
      }),
      getCodingAgentReviews: jest.fn().mockResolvedValue({
        ok: true,
        reviews,
      }),
      getCodingAgentReviewSnapshot: jest.fn(({ reviewId }: { reviewId: string }) => Promise.resolve({
        ok: true,
        snapshot: reviewId === "rev_mobile_2" ? secondSnapshot : reviewSnapshotFixture(),
      })),
      createCodingAgentSourcePullRequest: jest.fn(() => pullRequestResult.promise),
    };
    useGatewayMock.mockReturnValue(gatewayContext({
      client: client as unknown as GatewayClient,
      connectionState: "connected",
    }));

    render(<AgentsScreen />);

    await screen.findByLabelText("Open review PR #759");
    await act(async () => {
      fireEvent.press(screen.getByLabelText("Open review PR #759"));
    });
    await screen.findByText("packages/gateway/src/coding-agents/routes.ts");
    await act(async () => {
      fireEvent.press(screen.getByLabelText("Create pull request for review PR #759"));
    });
    await act(async () => {
      fireEvent.press(screen.getByLabelText("Open review PR #760"));
    });
    await screen.findByText("PR #760 review details");

    await act(async () => {
      pullRequestResult.resolve({
        ok: true,
        pullRequest: {
          status: "created",
          number: 808,
          url: "https://github.com/HamedMP/matrix-os/pull/808",
          headBranch: "feature/review-fix",
          baseBranch: "main",
          safeMessage: "Pull request is ready for review.",
        },
      });
      await pullRequestResult.promise;
    });

    expect(screen.queryByText("Pull request ready")).toBeNull();
    expect(screen.queryByText(/Pull request could not be created/i)).toBeNull();
  });

  it("ignores stale mobile save completions after another worktree opens the same path", async () => {
    const saveResult = deferred<{ ok: true; file: ReturnType<typeof fileWriteFixture> }>();
    const secondWorktreeFile = {
      ...fileReadFixture(),
      metadata: {
        ...fileReadFixture().metadata,
        etag: "sha256_mobile_file_second_worktree",
      },
      content: "export const safeRoute = 'second';\n",
    };
    const client = {
      getCodingAgentRuntimeSummary: jest.fn().mockResolvedValue({
        ok: true,
        summary: summaryFixture({ files: true }),
      }),
      getCodingAgentReviews: jest.fn().mockResolvedValue({
        ok: true,
        reviews: reviewsWithTwoWorktreesFixture(),
      }),
      getCodingAgentReviewSnapshot: jest.fn(({ reviewId }: { reviewId: string }) => Promise.resolve({
        ok: true,
        snapshot: reviewId === "rev_mobile_2" ? reviewSnapshotForSecondWorktreeFixture() : reviewSnapshotFixture(),
      })),
      getCodingAgentFileContent: jest.fn((request: { worktreeId: string }) => Promise.resolve({
        ok: true,
        file: request.worktreeId === "wt_mobile_2" ? secondWorktreeFile : fileReadFixture(),
      })),
      saveCodingAgentFileContent: jest.fn(() => saveResult.promise),
    };
    useGatewayMock.mockReturnValue(gatewayContext({
      client: client as unknown as GatewayClient,
      connectionState: "connected",
    }));

    render(<AgentsScreen />);

    await screen.findByLabelText("Open review PR #759");
    await act(async () => {
      fireEvent.press(screen.getByLabelText("Open review PR #759"));
    });
    await screen.findByText("packages/gateway/src/coding-agents/routes.ts");
    await act(async () => {
      fireEvent.press(screen.getByLabelText("Open file packages/gateway/src/coding-agents/routes.ts"));
    });
    const firstEditor = await screen.findByLabelText("Edit file packages/gateway/src/coding-agents/routes.ts");
    await act(async () => {
      fireEvent.changeText(firstEditor, "export const safeRoute = false;\n");
    });
    await act(async () => {
      fireEvent.press(screen.getByLabelText("Save file packages/gateway/src/coding-agents/routes.ts"));
    });
    await act(async () => {
      fireEvent.press(screen.getByLabelText("Open review PR #760"));
    });
    await screen.findByText("packages/gateway/src/coding-agents/routes.ts");
    await act(async () => {
      fireEvent.press(screen.getByLabelText("Open file packages/gateway/src/coding-agents/routes.ts"));
    });
    expect(await screen.findByDisplayValue("export const safeRoute = 'second';\n")).toBeTruthy();

    await act(async () => {
      saveResult.resolve({ ok: true, file: fileWriteFixture() });
      await saveResult.promise;
    });

    expect(screen.getByDisplayValue("export const safeRoute = 'second';\n")).toBeTruthy();
    expect(screen.queryByText("Saved")).toBeNull();
    expect(screen.queryByText("Saving")).toBeNull();
  });

  it("hides unsafe file paths from mobile editor accessibility labels", async () => {
    const unsafeFile = {
      ...fileReadFixture(),
      metadata: {
        ...fileReadFixture().metadata,
        path: "src/sk_live_1234567890abcdefghi.ts",
      },
    };
    const client = {
      getCodingAgentRuntimeSummary: jest.fn().mockResolvedValue({
        ok: true,
        summary: summaryFixture({ files: true }),
      }),
      getCodingAgentReviews: jest.fn().mockResolvedValue({
        ok: true,
        reviews: reviewsFixture(),
      }),
      getCodingAgentReviewSnapshot: jest.fn().mockResolvedValue({
        ok: true,
        snapshot: reviewSnapshotWithUnsafeFilePathFixture(),
      }),
      getCodingAgentFileContent: jest.fn().mockResolvedValue({
        ok: true,
        file: unsafeFile,
      }),
      saveCodingAgentFileContent: jest.fn().mockResolvedValue({
        ok: true,
        file: {
          ...fileWriteFixture(),
          metadata: {
            ...fileWriteFixture().metadata,
            path: "src/sk_live_1234567890abcdefghi.ts",
          },
        },
      }),
    };
    useGatewayMock.mockReturnValue(gatewayContext({
      client: client as unknown as GatewayClient,
      connectionState: "connected",
    }));

    render(<AgentsScreen />);

    await screen.findByText("matrix-os");
    await act(async () => {
      fireEvent.press(screen.getByLabelText("Open review PR #759"));
    });
    await screen.findByText("File path hidden for safety.");
    await act(async () => {
      fireEvent.press(screen.getByLabelText("Open file File path hidden for safety."));
    });
    const editor = await screen.findByLabelText("Edit file File path hidden for safety.");
    await act(async () => {
      fireEvent.changeText(editor, "export const safeRoute = false;\n");
    });

    expect(screen.queryByLabelText(/sk_live_/i)).toBeNull();
    expect(screen.getByLabelText("Save file File path hidden for safety.")).toBeTruthy();
    expect(screen.queryByText(/sk_live_/i)).toBeNull();
  });

  it("renders selectable review hunk metadata without raw diff contents", async () => {
    const client = {
      getCodingAgentRuntimeSummary: jest.fn().mockResolvedValue({
        ok: true,
        summary: summaryFixture(),
      }),
      getCodingAgentReviews: jest.fn().mockResolvedValue({
        ok: true,
        reviews: reviewsFixture(),
      }),
      getCodingAgentReviewSnapshot: jest.fn().mockResolvedValue({
        ok: true,
        snapshot: reviewSnapshotWithHunks(),
      }),
    };
    useGatewayMock.mockReturnValue(gatewayContext({
      client: client as unknown as GatewayClient,
      connectionState: "connected",
    }));

    render(<AgentsScreen />);

    await screen.findByText("matrix-os");
    await act(async () => {
      fireEvent.press(screen.getByLabelText("Open review PR #759"));
    });

    expect(await screen.findByText("packages/gateway/src/coding-agents/routes.ts")).toBeTruthy();
    expect(screen.getByText("+12")).toBeTruthy();
    expect(screen.getByText("-4")).toBeTruthy();
    expect(screen.getByText("@@ -42,3 +45,5 @@")).toBeTruthy();
    expect(screen.getByText("@@ -88,1 +93,2 @@")).toBeTruthy();
    expect(screen.getByText("Partial hunk")).toBeTruthy();

    const hunk = screen.getByLabelText("Select hunk 2 in packages/gateway/src/coding-agents/routes.ts");
    await act(async () => {
      fireEvent.press(hunk);
    });

    expect(hunk.props.accessibilityState?.selected).toBe(true);
    expect(screen.queryByText(/export const|function create|raw diff/i)).toBeNull();
  });

  it("renders bounded review diff lines with mobile old and new line labels", async () => {
    const client = {
      getCodingAgentRuntimeSummary: jest.fn().mockResolvedValue({
        ok: true,
        summary: summaryFixture(),
      }),
      getCodingAgentReviews: jest.fn().mockResolvedValue({
        ok: true,
        reviews: reviewsFixture(),
      }),
      getCodingAgentReviewSnapshot: jest.fn().mockResolvedValue({
        ok: true,
        snapshot: reviewSnapshotWithHunks(),
      }),
    };
    useGatewayMock.mockReturnValue(gatewayContext({
      client: client as unknown as GatewayClient,
      connectionState: "connected",
    }));

    render(<AgentsScreen />);

    await screen.findByText("matrix-os");
    await act(async () => {
      fireEvent.press(screen.getByLabelText("Open review PR #759"));
    });

    const contextLine = await screen.findByLabelText("Context line old 88 new 93");
    const removedLine = screen.getByLabelText("Removed line old 89");
    const addedLine = screen.getByLabelText("Added line new 94");

    expect(contextLine.props.children).toContain("const request = parseReviewRequest(input);");
    expect(removedLine.props.children).toContain("return rawReviewDetails;");
    expect(addedLine.props.children).toContain("return safeReviewDetails;");
    expect(screen.getByText("+")).toBeTruthy();
    expect(screen.getByText("-")).toBeTruthy();
  });

  it("opens the mobile composer with bounded selected review hunk context", async () => {
    const client = {
      getCodingAgentRuntimeSummary: jest.fn().mockResolvedValue({
        ok: true,
        summary: summaryFixture({ threadCreate: true }),
      }),
      getCodingAgentReviews: jest.fn().mockResolvedValue({
        ok: true,
        reviews: reviewsFixture(),
      }),
      getCodingAgentReviewSnapshot: jest.fn().mockResolvedValue({
        ok: true,
        snapshot: reviewSnapshotWithHunks(),
      }),
    };
    useGatewayMock.mockReturnValue(gatewayContext({
      client: client as unknown as GatewayClient,
      connectionState: "connected",
    }));

    render(<AgentsScreen />);

    await screen.findByText("matrix-os");
    await act(async () => {
      fireEvent.press(screen.getByLabelText("Open review PR #759"));
    });
    await act(async () => {
      fireEvent.press(screen.getByLabelText("Select hunk 2 in packages/gateway/src/coding-agents/routes.ts"));
    });
    await act(async () => {
      fireEvent.press(screen.getByLabelText("Ask agent about selected hunk"));
    });

    expect(mockRouterPush).toHaveBeenCalledWith({
      pathname: "/agents/new",
      params: expect.objectContaining({
        reviewId: "rev_mobile_1",
        projectId: "matrix-os",
        pullRequestNumber: "759",
        round: "2",
        maxRounds: "3",
        filePath: "packages/gateway/src/coding-agents/routes.ts",
        hunkId: "hunk_rev_mobile_1_0_1",
        hunkIndex: "1",
        oldStart: "88",
        oldLines: "1",
        newStart: "93",
        newLines: "2",
      }),
    });
  });

  it("clears selected hunk state when a selected review snapshot refreshes", async () => {
    const client = {
      getCodingAgentRuntimeSummary: jest.fn().mockResolvedValue({
        ok: true,
        summary: summaryFixture(),
      }),
      getCodingAgentReviews: jest.fn().mockResolvedValue({
        ok: true,
        reviews: reviewsFixture(),
      }),
      getCodingAgentReviewSnapshot: jest.fn()
        .mockResolvedValueOnce({
          ok: true,
          snapshot: reviewSnapshotWithHunks(),
        })
        .mockResolvedValueOnce({
          ok: true,
          snapshot: reviewSnapshotWithChangedHunks(),
        }),
    };
    useGatewayMock.mockReturnValue(gatewayContext({
      client: client as unknown as GatewayClient,
      connectionState: "connected",
    }));

    render(<AgentsScreen />);

    await screen.findByText("matrix-os");
    await act(async () => {
      fireEvent.press(screen.getByLabelText("Open review PR #759"));
    });

    const selectedBeforeRefresh = screen.getByLabelText("Select hunk 2 in packages/gateway/src/coding-agents/routes.ts");
    await act(async () => {
      fireEvent.press(selectedBeforeRefresh);
    });
    expect(selectedBeforeRefresh.props.accessibilityState?.selected).toBe(true);

    await act(async () => {
      screen.getByLabelText("Refresh agent workspace").props.refreshControl.props.onRefresh();
    });

    expect(await screen.findByText("@@ -120,4 +130,6 @@")).toBeTruthy();
    const refreshedHunk = screen.getByLabelText("Select hunk 2 in packages/gateway/src/coding-agents/routes.ts");
    expect(refreshedHunk.props.accessibilityState?.selected).toBe(false);
  });

  it("renders a generic review error without dropping the runtime summary", async () => {
    const client = {
      getCodingAgentRuntimeSummary: jest.fn().mockResolvedValue({
        ok: true,
        summary: summaryFixture(),
      }),
      getCodingAgentReviews: jest.fn().mockResolvedValue({
        ok: false,
        error: "review store failed at /home/matrix/private token secret",
      }),
    };
    useGatewayMock.mockReturnValue(gatewayContext({
      client: client as unknown as GatewayClient,
      connectionState: "connected",
    }));

    render(<AgentsScreen />);

    await screen.findByText("Primary");
    expect(await screen.findByText("Review state unavailable")).toBeTruthy();
    expect(screen.queryByText(/home\/matrix|token|secret/i)).toBeNull();
  });

  it("clears loaded review details when review summaries become unavailable", async () => {
    const client = {
      getCodingAgentRuntimeSummary: jest.fn().mockResolvedValue({
        ok: true,
        summary: summaryFixture(),
      }),
      getCodingAgentReviews: jest.fn()
        .mockResolvedValueOnce({
          ok: true,
          reviews: reviewsFixture(),
        })
        .mockResolvedValueOnce({
          ok: false,
          error: "Review state unavailable",
        }),
      getCodingAgentReviewSnapshot: jest.fn().mockResolvedValue({
        ok: true,
        snapshot: reviewSnapshotFixture(),
      }),
    };
    useGatewayMock.mockReturnValue(gatewayContext({
      client: client as unknown as GatewayClient,
      connectionState: "connected",
    }));

    render(<AgentsScreen />);

    await screen.findByText("matrix-os");
    await act(async () => {
      fireEvent.press(screen.getByLabelText("Open review PR #759"));
    });
    expect(await screen.findByText("Validate ownership before returning snapshots.")).toBeTruthy();

    await act(async () => {
      screen.getByLabelText("Refresh agent workspace").props.refreshControl.props.onRefresh();
    });

    expect(await screen.findByText("Review state unavailable")).toBeTruthy();
    expect(screen.queryByText("Validate ownership before returning snapshots.")).toBeNull();
    expect(screen.queryByText("packages/gateway/src/coding-agents/routes.ts")).toBeNull();
    expect(screen.queryByText(/home\/matrix|token|secret/i)).toBeNull();
  });

  it("reloads selected review details when refreshed summaries still include the review", async () => {
    const client = {
      getCodingAgentRuntimeSummary: jest.fn().mockResolvedValue({
        ok: true,
        summary: summaryFixture(),
      }),
      getCodingAgentReviews: jest.fn().mockResolvedValue({
        ok: true,
        reviews: reviewsFixture(),
      }),
      getCodingAgentReviewSnapshot: jest.fn()
        .mockResolvedValueOnce({
          ok: true,
          snapshot: reviewSnapshotWithFinding("Initial review finding."),
        })
        .mockResolvedValueOnce({
          ok: true,
          snapshot: reviewSnapshotWithFinding("Fresh review finding after refresh."),
        }),
    };
    useGatewayMock.mockReturnValue(gatewayContext({
      client: client as unknown as GatewayClient,
      connectionState: "connected",
    }));

    render(<AgentsScreen />);

    await screen.findByText("matrix-os");
    await act(async () => {
      fireEvent.press(screen.getByLabelText("Open review PR #759"));
    });
    expect(await screen.findByText("Initial review finding.")).toBeTruthy();

    await act(async () => {
      screen.getByLabelText("Refresh agent workspace").props.refreshControl.props.onRefresh();
    });

    expect(await screen.findByText("Fresh review finding after refresh.")).toBeTruthy();
    expect(screen.queryByText("Initial review finding.")).toBeNull();
    expect(client.getCodingAgentReviewSnapshot).toHaveBeenCalledTimes(2);
  });

  it.each([
    `${"ghs_"}abcdefghijklmnopqrstuvwxyz1234567890`,
    `${"glpat-"}abcdefghijklmnopqrstuvwxyz1234567890`,
    `${"npm_"}abcdefghijklmnopqrstuvwxyz1234567890`,
    `${"ya29"}abcdefghijklmnopqrstuvwxyz1234567890`,
    `sk_${"live"}_abcdefghijklmnopqrstuvwxyz1234567890`,
  ])("redacts token-shaped finding summaries in the review snapshot panel", async (credential) => {
    const client = {
      getCodingAgentRuntimeSummary: jest.fn().mockResolvedValue({
        ok: true,
        summary: summaryFixture(),
      }),
      getCodingAgentReviews: jest.fn().mockResolvedValue({
        ok: true,
        reviews: reviewsFixture(),
      }),
      getCodingAgentReviewSnapshot: jest.fn().mockResolvedValue({
        ok: true,
        snapshot: reviewSnapshotWithFinding(`Rotate ${credential} before merge.`),
      }),
    };
    useGatewayMock.mockReturnValue(gatewayContext({
      client: client as unknown as GatewayClient,
      connectionState: "connected",
    }));

    render(<AgentsScreen />);

    await screen.findByText("matrix-os");
    await act(async () => {
      fireEvent.press(screen.getByLabelText("Open review PR #759"));
    });

    expect(await screen.findByText("Finding summary hidden for safety.")).toBeTruthy();
    expect(screen.queryByText(new RegExp(`ghs_|glpat-|npm_|ya29|sk_${"live"}_|token|secret`, "i"))).toBeNull();
  });

  it("redacts token-shaped review notices and file paths", async () => {
    const snapshot = {
      ...reviewSnapshotFixture(),
      safeNotice: `Rotate ${"ghs_"}abcdefghijklmnopqrstuvwxyz1234567890 before showing details.`,
      files: {
        ...reviewSnapshotFixture().files,
        items: reviewSnapshotFixture().files.items.map((file) => ({
          ...file,
          path: `src/${"ghp_"}abcdefghijklmnopqrstuvwxyz1234567890/config.ts`,
        })),
      },
    };
    const client = {
      getCodingAgentRuntimeSummary: jest.fn().mockResolvedValue({
        ok: true,
        summary: summaryFixture(),
      }),
      getCodingAgentReviews: jest.fn().mockResolvedValue({
        ok: true,
        reviews: reviewsFixture(),
      }),
      getCodingAgentReviewSnapshot: jest.fn().mockResolvedValue({
        ok: true,
        snapshot,
      }),
    };
    useGatewayMock.mockReturnValue(gatewayContext({
      client: client as unknown as GatewayClient,
      connectionState: "connected",
    }));

    render(<AgentsScreen />);

    await screen.findByText("matrix-os");
    await act(async () => {
      fireEvent.press(screen.getByLabelText("Open review PR #759"));
    });

    expect(await screen.findByText("Review notice hidden for safety.")).toBeTruthy();
    expect(screen.getByText("File path hidden for safety.")).toBeTruthy();
    expect(screen.queryByText(/ghs_|ghp_|token|secret/i)).toBeNull();
  });

  it("renders duplicate file paths and finding ids without duplicate key warnings", async () => {
    const consoleError = jest.spyOn(console, "error").mockImplementation(() => undefined);
    const snapshot = {
      ...reviewSnapshotFixture(),
      files: {
        items: [
          {
            path: "packages/gateway/src/coding-agents/routes.ts",
            status: "modified",
            additions: 0,
            deletions: 0,
            partial: true,
            hunks: [],
            findings: [
              {
                id: "HIGH-1",
                severity: "high",
                line: 42,
                summary: "First duplicate-key finding.",
              },
              {
                id: "HIGH-1",
                severity: "high",
                line: 43,
                summary: "Second duplicate-key finding.",
              },
            ],
          },
          {
            path: "packages/gateway/src/coding-agents/routes.ts",
            status: "modified",
            additions: 0,
            deletions: 0,
            partial: true,
            hunks: [],
            findings: [],
          },
        ],
        hasMore: false,
        limit: 100,
      },
    };
    const client = {
      getCodingAgentRuntimeSummary: jest.fn().mockResolvedValue({
        ok: true,
        summary: summaryFixture(),
      }),
      getCodingAgentReviews: jest.fn().mockResolvedValue({
        ok: true,
        reviews: reviewsFixture(),
      }),
      getCodingAgentReviewSnapshot: jest.fn().mockResolvedValue({
        ok: true,
        snapshot,
      }),
    };
    useGatewayMock.mockReturnValue(gatewayContext({
      client: client as unknown as GatewayClient,
      connectionState: "connected",
    }));

    render(<AgentsScreen />);

    await screen.findByText("matrix-os");
    await act(async () => {
      fireEvent.press(screen.getByLabelText("Open review PR #759"));
    });

    expect(await screen.findByText("First duplicate-key finding.")).toBeTruthy();
    expect(screen.getByText("Second duplicate-key finding.")).toBeTruthy();
    expect(screen.getAllByText("packages/gateway/src/coding-agents/routes.ts")).toHaveLength(2);
    expect(consoleError).not.toHaveBeenCalledWith(expect.stringContaining("Encountered two children with the same key"), expect.anything());
    consoleError.mockRestore();
  });

  it("clears loaded review details when runtime summary refresh fails", async () => {
    const client = {
      getCodingAgentRuntimeSummary: jest.fn()
        .mockResolvedValueOnce({
          ok: true,
          summary: summaryFixture(),
        })
        .mockResolvedValueOnce({
          ok: false,
          error: "Runtime summary unavailable",
        }),
      getCodingAgentReviews: jest.fn().mockResolvedValue({
        ok: true,
        reviews: reviewsFixture(),
      }),
      getCodingAgentReviewSnapshot: jest.fn().mockResolvedValue({
        ok: true,
        snapshot: reviewSnapshotFixture(),
      }),
    };
    useGatewayMock.mockReturnValue(gatewayContext({
      client: client as unknown as GatewayClient,
      connectionState: "connected",
    }));

    render(<AgentsScreen />);

    await screen.findByText("matrix-os");
    await act(async () => {
      fireEvent.press(screen.getByLabelText("Open review PR #759"));
    });
    expect(await screen.findByText("Validate ownership before returning snapshots.")).toBeTruthy();

    await act(async () => {
      screen.getByLabelText("Refresh agent workspace").props.refreshControl.props.onRefresh();
    });

    await waitFor(() => {
      expect(screen.queryByText("Validate ownership before returning snapshots.")).toBeNull();
    });
    expect(screen.queryByText("packages/gateway/src/coding-agents/routes.ts")).toBeNull();
    expect(screen.queryByText(/home\/matrix|token|secret/i)).toBeNull();
  });

  it("does not restore an in-flight review snapshot after refresh removes the review", async () => {
    const snapshotRequest = deferred<{ ok: true; snapshot: ReturnType<typeof reviewSnapshotFixture> }>();
    const client = {
      getCodingAgentRuntimeSummary: jest.fn().mockResolvedValue({
        ok: true,
        summary: summaryFixture(),
      }),
      getCodingAgentReviews: jest.fn()
        .mockResolvedValueOnce({
          ok: true,
          reviews: reviewsFixture(),
        })
        .mockResolvedValueOnce({
          ok: true,
          reviews: { items: [], hasMore: false, limit: 50 },
        }),
      getCodingAgentReviewSnapshot: jest.fn(() => snapshotRequest.promise),
    };
    useGatewayMock.mockReturnValue(gatewayContext({
      client: client as unknown as GatewayClient,
      connectionState: "connected",
    }));

    render(<AgentsScreen />);

    await screen.findByText("matrix-os");
    await act(async () => {
      fireEvent.press(screen.getByLabelText("Open review PR #759"));
    });
    expect(await screen.findByText("Loading review details...")).toBeTruthy();

    await act(async () => {
      screen.getByLabelText("Refresh agent workspace").props.refreshControl.props.onRefresh();
    });
    expect(await screen.findByText("No reviews.")).toBeTruthy();

    await act(async () => {
      snapshotRequest.resolve({ ok: true, snapshot: reviewSnapshotFixture() });
      await snapshotRequest.promise;
    });

    await waitFor(() => {
      expect(screen.queryByText("Validate ownership before returning snapshots.")).toBeNull();
    });
    expect(screen.queryByText("packages/gateway/src/coding-agents/routes.ts")).toBeNull();
  });

  it("renders a safe error when the runtime summary is unavailable", async () => {
    const client = {
      getCodingAgentRuntimeSummary: jest.fn().mockResolvedValue({
        ok: false,
        error: "Runtime summary unavailable",
      }),
      getCodingAgentReviews: jest.fn(),
    };
    useGatewayMock.mockReturnValue(gatewayContext({
      client: client as unknown as GatewayClient,
      connectionState: "connected",
    }));

    render(<AgentsScreen />);

    await waitFor(() => expect(screen.getByText("Runtime summary unavailable")).toBeTruthy());
    expect(screen.queryByText(/home\/matrix/)).toBeNull();
  });

  it("ignores a delayed summary from a previous gateway client", async () => {
    const oldRequest = deferred<{ ok: true; summary: ReturnType<typeof summaryFixture> }>();
    const oldClient = {
      getCodingAgentRuntimeSummary: jest.fn(() => oldRequest.promise),
      getCodingAgentReviews: jest.fn(),
    };
    const newClient = {
      getCodingAgentRuntimeSummary: jest.fn().mockResolvedValue({
        ok: true,
        summary: {
          ...summaryFixture(),
          runtime: {
            id: "rt_new",
            label: "New runtime",
            status: "available",
          },
        },
      }),
      getCodingAgentReviews: jest.fn().mockResolvedValue({
        ok: true,
        reviews: reviewsFixture(),
      }),
    };
    useGatewayMock.mockReturnValue(gatewayContext({
      client: oldClient as unknown as GatewayClient,
      connectionState: "connected",
    }));

    const view = render(<AgentsScreen />);

    useGatewayMock.mockReturnValue(gatewayContext({
      client: newClient as unknown as GatewayClient,
      connectionState: "connected",
    }));
    view.rerender(<AgentsScreen />);
    await screen.findByText("New runtime");

    await act(async () => {
      oldRequest.resolve({
        ok: true,
        summary: {
          ...summaryFixture(),
          runtime: {
            id: "rt_old",
            label: "Old runtime",
            status: "available",
          },
        },
      });
      await oldRequest.promise;
    });

    await waitFor(() => {
      expect(screen.queryByText("Old runtime")).toBeNull();
      expect(screen.getByText("New runtime")).toBeTruthy();
    });
  });
});
