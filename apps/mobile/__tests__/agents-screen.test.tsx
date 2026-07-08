jest.mock("@/app/_layout", () => ({
  useGateway: jest.fn(),
}));

jest.mock("@/lib/feature-flags", () => ({
  CODING_AGENTS_MOBILE_WORKSPACE: true,
}));

const mockRouterPush = jest.fn();

jest.mock("expo-router", () => ({
  useRouter: () => ({
    push: mockRouterPush,
  }),
}));

import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import AgentsScreen from "../app/agents";
import { useGateway } from "@/app/_layout";
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

function summaryFixture({ threadCreate = false, files = false }: { threadCreate?: boolean; files?: boolean } = {}) {
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
    expect(screen.getByText("Repair mobile route")).toBeTruthy();
    expect(screen.getByText("matrix-abc1234")).toBeTruthy();
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

    await screen.findByText("Repair mobile route");
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

    expect(await screen.findByText("Approve deployment")).toBeTruthy();
    expect(screen.getByText("Approval needed")).toBeTruthy();
    expect(screen.getByText("Input needed")).toBeTruthy();
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
    expect(screen.getByText("Approve deployment")).toBeTruthy();
    expect(screen.getByText("Repair failed run")).toBeTruthy();
    expect(screen.getByText("Approval needed")).toBeTruthy();
    expect(screen.getByText("Failed")).toBeTruthy();
    expect(screen.getByText("No active threads.")).toBeTruthy();

    await act(async () => {
      fireEvent.press(screen.getByLabelText("Open attention thread Repair failed run, Failed"));
    });
    expect(mockRouterPush).toHaveBeenCalledWith("/agents/thread_failed");
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

    await screen.findByText("matrix-os");
    await act(async () => {
      fireEvent.press(screen.getByLabelText("Open review PR #759"));
    });

    expect(client.getCodingAgentReviewSnapshot).toHaveBeenCalledWith({ reviewId: "rev_mobile_1" });
    expect(await screen.findByText("packages/gateway/src/coding-agents/routes.ts")).toBeTruthy();
    expect(screen.getByText("Validate ownership before returning snapshots.")).toBeTruthy();
    expect(screen.getByText("Diff content is not available yet. Showing bounded review findings.")).toBeTruthy();
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

    await screen.findByText("matrix-os");
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
    expect(await screen.findByText("export const safeRoute = true;")).toBeTruthy();
    expect(screen.queryByText(/home\/matrix|token|secret/i)).toBeNull();
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
