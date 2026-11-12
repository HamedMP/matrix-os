// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useWorkRailPage } from "@desktop/renderer/src/features/work/work-rail/useWorkRailPage";

afterEach(cleanup);

it("keeps a status group's visible rows while loading its independent next page", async () => {
  const record = (index: number) => ({ chat: { id: `chat_${index}` } });
  let finishNext!: (value: unknown) => void;
  const next = new Promise(resolve => { finishNext = resolve; });
  const navigationPage = vi.fn(async (query: { cursor?: string }) => query.cursor ? next
    : { items: Array.from({ length: 10 }, (_, index) => record(index)), totalCount: 31, nextCursor: "navcur_next" });
  const client = { navigationPage } as never;
  const { result } = renderHook(() => useWorkRailPage(client, { group: "done" }, "owner/main", 0, 10));
  await waitFor(() => expect(result.current.rows).toHaveLength(10));
  expect(navigationPage).toHaveBeenCalledWith({ group: "done", limit: 10 });
  act(() => result.current.loadMore());
  expect(result.current.rows).toHaveLength(10);
  expect(result.current.count).toBe(31);
  expect(result.current.loading).toBe(true);
  await act(async () => finishNext({ items: Array.from({ length: 20 }, (_, index) => record(index + 10)), totalCount: 31, nextCursor: "navcur_end" }));
  await waitFor(() => expect(result.current.rows).toHaveLength(30));
  expect(navigationPage).toHaveBeenCalledWith({ group: "done", limit: 20, cursor: "navcur_next" });
});

it("loads a project's first five chats without sharing the status cursor", async () => {
  const navigationPage = vi.fn(async () => ({ items: [], totalCount: 0 }));
  const client = { navigationPage } as never;
  renderHook(() => useWorkRailPage(client, { group: "project", projectId: "proj_a" }, "owner/main", 0, 5));
  await waitFor(() => expect(navigationPage).toHaveBeenCalledWith({ group: "project", projectId: "proj_a", limit: 5 }));
});
