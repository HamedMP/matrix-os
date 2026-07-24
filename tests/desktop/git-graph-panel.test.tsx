// @vitest-environment jsdom

import React from "react";
import * as Tooltip from "@radix-ui/react-tooltip";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "../../desktop/src/shared/app-error";
import GitPanel from "../../desktop/src/renderer/src/features/git/GitPanel";
import { GitGraph } from "../../desktop/src/renderer/src/features/git/GitGraph";
import { diffLineKind } from "../../desktop/src/renderer/src/features/git/GitCommitDetail";
import type { ApiClient } from "../../desktop/src/renderer/src/lib/api";
import { useConnection } from "../../desktop/src/renderer/src/stores/connection";
import { useGit } from "../../desktop/src/renderer/src/stores/git";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const SHA_C = "c".repeat(40);

function commit(overrides: Record<string, unknown>) {
  return {
    sha: SHA_C,
    parents: [],
    author: "Alice",
    timestamp: "2026-07-19T10:00:00+00:00",
    subject: "Initial commit",
    refs: [],
    tags: [],
    head: false,
    ...overrides,
  };
}

const PAGE = {
  commits: [
    commit({ sha: SHA_A, parents: [SHA_B], subject: "Wire the graph", refs: ["main"], head: true }),
    commit({ sha: SHA_B, parents: [SHA_C], author: "Bob", subject: "Add lanes", tags: ["v0.1"] }),
    commit({ sha: SHA_C, subject: "Initial commit" }),
  ],
  nextCursor: null,
  refreshedAt: "2026-07-19T12:00:00.000Z",
};

const DIFF = {
  files: [
    {
      path: "src/a.ts",
      oldPath: null,
      status: "M",
      additions: 2,
      deletions: 1,
      binary: false,
      patch: "@@ -1,2 +1,3 @@\n line\n-old\n+new\n+more",
      truncated: false,
    },
    {
      path: "bin.dat",
      oldPath: null,
      status: "M",
      additions: null,
      deletions: null,
      binary: true,
      patch: null,
      truncated: false,
    },
  ],
  truncated: false,
  refreshedAt: "2026-07-19T12:00:00.000Z",
};

function routedGet(routes: Record<string, unknown>) {
  return vi.fn(async (path: string) => {
    for (const [needle, value] of Object.entries(routes)) {
      if (path.includes(needle)) {
        if (value instanceof Error) throw value;
        return value;
      }
    }
    throw new Error(`unmocked path: ${path}`);
  });
}

function makeApi(routes: Record<string, unknown>): ApiClient {
  return { baseUrl: "https://x.test", get: routedGet(routes) } as unknown as ApiClient;
}

function renderPanel(api: ApiClient | null) {
  useConnection.setState({ api } as never);
  return render(
    <Tooltip.Provider>
      <GitPanel projectSlug="repo" />
    </Tooltip.Provider>,
  );
}

const HEALTHY_ROUTES: Record<string, unknown> = {
  [`/commits/${SHA_A}/diff`]: DIFF,
  "/commits": PAGE,
  "/branches": { branches: [{ name: "main" }] },
  "/prs": { prs: [] },
  "/worktrees": { worktrees: [] },
};

describe("GitPanel graph tab", () => {
  beforeEach(() => {
    useGit.setState({
      branches: [],
      prs: [],
      worktrees: [],
      previews: [],
      previewScope: null,
      refreshedAt: null,
      loading: false,
      error: null,
      previewError: null,
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("renders the commit DAG with ref pills, tags, and a HEAD marker", async () => {
    renderPanel(makeApi(HEALTHY_ROUTES));

    await waitFor(() => expect(screen.getByText("Wire the graph")).toBeTruthy());
    expect(screen.getByText("Add lanes")).toBeTruthy();
    expect(screen.getByText("Initial commit")).toBeTruthy();
    expect(screen.getByText("HEAD")).toBeTruthy();
    expect(screen.getByText("main")).toBeTruthy();
    expect(screen.getByText("v0.1")).toBeTruthy();
    expect(screen.getAllByText(/Alice/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Bob/).length).toBeGreaterThan(0);
  });

  it("opens commit detail on click and expands per-file diffs with +/- lines", async () => {
    renderPanel(makeApi(HEALTHY_ROUTES));

    await waitFor(() => expect(screen.getByText("Wire the graph")).toBeTruthy());
    fireEvent.click(screen.getByText("Wire the graph"));

    await waitFor(() => expect(screen.getByText("src/a.ts")).toBeTruthy());
    expect(screen.getByText("bin.dat")).toBeTruthy();
    expect(screen.getByText("binary")).toBeTruthy();

    fireEvent.click(screen.getByText("src/a.ts"));
    await waitFor(() => expect(screen.getByText("+new")).toBeTruthy());
    expect(screen.getByText("-old")).toBeTruthy();
    expect(screen.getByText("@@ -1,2 +1,3 @@")).toBeTruthy();

    const addLine = screen.getByText("+new").closest("[data-diff-kind]");
    expect(addLine?.getAttribute("data-diff-kind")).toBe("add");
    const delLine = screen.getByText("-old").closest("[data-diff-kind]");
    expect(delLine?.getAttribute("data-diff-kind")).toBe("del");

    fireEvent.click(screen.getByLabelText("Close commit detail"));
    await waitFor(() => expect(screen.queryByTestId("git-commit-detail")).toBeNull());
  });

  it("hides the Graph tab and keeps the classic view when the gateway lacks the endpoints", async () => {
    renderPanel(
      makeApi({
        "/commits": new AppError("notFound"),
        "/branches": { branches: [{ name: "main" }] },
        "/prs": { prs: [] },
        "/worktrees": { worktrees: [] },
      }),
    );

    await waitFor(() => expect(screen.getByText("Branches (1)")).toBeTruthy());
    expect(screen.queryByRole("tab", { name: "Graph" })).toBeNull();
    expect(screen.getByRole("tab", { name: "Branches" })).toBeTruthy();
    expect(screen.getByText("main")).toBeTruthy();
  });

  it("shows a recoverable error state when the log request fails", async () => {
    const api = makeApi({
      "/commits": new AppError("offline"),
      "/branches": { branches: [] },
      "/prs": { prs: [] },
      "/worktrees": { worktrees: [] },
    });
    renderPanel(api);

    await waitFor(() => expect(screen.getByRole("status").textContent).toMatch(/reach/i));
    const callsBefore = (api.get as ReturnType<typeof vi.fn>).mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() =>
      expect((api.get as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(callsBefore),
    );
    // Graph tab stays available: a transient failure is not a capability signal.
    expect(screen.getByRole("tab", { name: "Graph" })).toBeTruthy();
  });

  it("switches to the classic view via the Branches tab", async () => {
    renderPanel(makeApi(HEALTHY_ROUTES));

    await waitFor(() => expect(screen.getByText("Wire the graph")).toBeTruthy());
    fireEvent.click(screen.getByRole("tab", { name: "Branches" }));

    await waitFor(() => expect(screen.getByText("Branches (1)")).toBeTruthy());
    expect(screen.queryByText("Wire the graph")).toBeNull();
  });

  it("shows an empty state for repositories without commits", async () => {
    renderPanel(makeApi({ ...HEALTHY_ROUTES, "/commits": { commits: [], nextCursor: null } }));

    await waitFor(() => expect(screen.getByText("No commits yet")).toBeTruthy());
  });

  it("pages older commits with the cursor via Load more", async () => {
    const api = makeApi({
      "cursor=1": { commits: [commit({ sha: SHA_B, subject: "Older work" })], nextCursor: null },
      "/commits": { commits: [commit({ sha: SHA_A, subject: "Newest work" })], nextCursor: "1" },
      "/branches": { branches: [] },
      "/prs": { prs: [] },
      "/worktrees": { worktrees: [] },
    });
    renderPanel(api);

    await waitFor(() => expect(screen.getByText("Newest work")).toBeTruthy());
    expect(screen.queryByText("Older work")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    await waitFor(() => expect(screen.getByText("Older work")).toBeTruthy());
    const getMock = api.get as ReturnType<typeof vi.fn>;
    expect(getMock.mock.calls.some(([path]) => String(path).includes("cursor=1"))).toBe(true);
  });
});

describe("GitGraph virtualization", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders only a window of rows for large histories", () => {
    const many = Array.from({ length: 500 }, (_, i) =>
      commit({ sha: String(i).padStart(40, "0"), subject: `Commit ${i}`, parents: i < 499 ? [String(i + 1).padStart(40, "0")] : [] }),
    );
    render(
      <GitGraph
        commits={many}
        selectedSha={null}
        onSelect={() => undefined}
        hasMore={false}
        capped={false}
        loadingMore={false}
        onLoadMore={() => undefined}
      />,
    );

    const scroller = screen.getByTestId("git-graph-scroll");
    const renderedRows = within(scroller).getAllByRole("button");
    expect(renderedRows.length).toBeLessThan(100);
    expect(renderedRows.length).toBeGreaterThan(5);
  });

  it("announces the cap instead of Load more at the hard history limit", () => {
    const many = Array.from({ length: 2000 }, (_, i) =>
      commit({ sha: String(i).padStart(40, "0"), subject: `Commit ${i}` }),
    );
    render(
      <GitGraph
        commits={many}
        selectedSha={null}
        onSelect={() => undefined}
        hasMore={false}
        capped
        loadingMore={false}
        onLoadMore={() => undefined}
      />,
    );

    expect(screen.getByText(/Showing the most recent/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
  });
});

describe("diffLineKind", () => {
  it("classifies unified diff lines", () => {
    expect(diffLineKind("@@ -1 +1 @@")).toBe("hunk");
    expect(diffLineKind("+added")).toBe("add");
    expect(diffLineKind("-removed")).toBe("del");
    expect(diffLineKind("\\ No newline at end of file")).toBe("meta");
    expect(diffLineKind(" context")).toBe("context");
    expect(diffLineKind("")).toBe("context");
  });
});
