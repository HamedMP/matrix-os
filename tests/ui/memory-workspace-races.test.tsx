// @vitest-environment jsdom
import React from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { MemoryWorkspace } from "../../packages/ui/src/memory-workspace/MemoryWorkspace";
import { MemorySearch } from "../../packages/ui/src/memory-workspace/MemorySearch";
import type {
  MemorySource,
  MemorySnapshot,
  MemoryWorkspaceClient,
  MemorySearchResult,
} from "../../packages/ui/src/memory-workspace/model";

const alpha: MemorySource = {
  id: "alpha",
  title: "Note Alpha",
  content: "Alpha text",
  preview: "Alpha text",
  kind: "note",
  collection: "Notes",
  revision: 1,
  occurredAt: null,
  updatedAt: "2026-10-05T10:00:00Z",
  ingestion: { hindsight: "ready", openviking: "pending" },
};
const beta: MemorySource = {
  ...alpha,
  id: "beta",
  title: "Note Beta",
  content: "Beta text",
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture() {
  const snapshot: MemorySnapshot = {
    sources: [alpha, beta],
    totalSources: 2,
    filteredSources: 2,
    collections: [],
    collectionsTruncated: false,
    hasMore: false,
    nextCursor: null,
    jobs: [],
    engines: [],
  };
  const client = {
    snapshot: vi.fn().mockResolvedValue(snapshot),
    getSource: vi
      .fn()
      .mockImplementation(async (id: string) =>
        id === alpha.id ? alpha : beta,
      ),
    importSources: vi.fn(),
    updateSource: vi.fn(),
    deleteSource: vi.fn().mockResolvedValue(undefined),
    search: vi.fn(),
    compare: vi.fn(),
    actJob: vi.fn(),
  } satisfies MemoryWorkspaceClient;
  return { client, snapshot };
}
afterEach(cleanup);

it("finishes an abandoned reader when filters change during a source request", async () => {
  const { client } = fixture();
  const pending = deferred<MemorySource>();
  client.getSource.mockReturnValueOnce(pending.promise);
  render(<MemoryWorkspace client={client} identity="owner" />);
  fireEvent.click(await screen.findByRole("button", { name: /Note Alpha/ }));
  fireEvent.click(screen.getByRole("button", { name: "Notes", exact: true }));
  await waitFor(() => expect(client.snapshot).toHaveBeenCalledTimes(2));
  await act(async () => {
    pending.resolve(alpha);
    await pending.promise;
  });
  expect(screen.queryByText("Opening source")).toBeNull();
  expect(screen.queryByRole("heading", { name: "Note Alpha" })).toBeNull();
});

it("preserves a newer reader when deleting the previously selected source", async () => {
  const { client } = fixture();
  const pending = deferred<void>();
  client.deleteSource.mockReturnValueOnce(pending.promise);
  render(<MemoryWorkspace client={client} identity="owner" />);
  fireEvent.click(await screen.findByRole("button", { name: /Note Alpha/ }));
  await screen.findByRole("heading", { name: "Note Alpha" });
  fireEvent.click(screen.getByRole("button", { name: "Delete", exact: true }));
  fireEvent.click(screen.getByRole("button", { name: "Delete source" }));
  fireEvent.click(screen.getByRole("button", { name: /Note Beta/ }));
  await screen.findByRole("heading", { name: "Note Beta" });
  await act(async () => {
    pending.resolve();
    await pending.promise;
  });
  expect(screen.getByRole("heading", { name: "Note Beta" })).toBeTruthy();
});

it("discards a pending response after choosing a different memory engine", async () => {
  const { client } = fixture();
  const pending = deferred<MemorySearchResult>();
  client.search.mockReturnValueOnce(pending.promise);
  render(
    <MemorySearch client={client} compare={false} onOpenSource={() => {}} />,
  );
  fireEvent.change(screen.getByRole("textbox", { name: "Ask your memory" }), {
    target: { value: "travel" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Search memory" }));
  fireEvent.change(screen.getByRole("combobox", { name: "Memory engine" }), {
    target: { value: "openviking" },
  });
  await act(async () => {
    pending.resolve({
      engine: "hindsight",
      status: "ready",
      hits: [],
      latencyMs: 5,
    });
    await pending.promise;
  });
  expect(screen.queryByRole("heading", { name: "Hindsight" })).toBeNull();
  expect(
    screen
      .getByRole("button", { name: "Search memory" })
      .hasAttribute("disabled"),
  ).toBe(false);
});

it("allows retrying failed removals but never cancelling a pending removal", async () => {
  const { client, snapshot } = fixture();
  snapshot.jobs = [
    {
      id: "pending-delete",
      sourceId: alpha.id,
      engine: "hindsight",
      revision: 1,
      operation: "delete",
      status: "pending",
      attempts: 0,
      updatedAt: alpha.updatedAt,
    },
    {
      id: "failed-delete",
      sourceId: beta.id,
      engine: "openviking",
      revision: 1,
      operation: "delete",
      status: "failed",
      attempts: 3,
      updatedAt: alpha.updatedAt,
    },
  ];
  render(<MemoryWorkspace client={client} identity="owner" />);
  await screen.findByRole("button", { name: /Note Alpha/ });
  fireEvent.click(screen.getByRole("button", { name: "Learning activity" }));
  expect(
    screen.queryByRole("button", { name: "Cancel", exact: true }),
  ).toBeNull();
  expect(
    screen.getByRole("button", { name: "Retry", exact: true }),
  ).toBeTruthy();
});
