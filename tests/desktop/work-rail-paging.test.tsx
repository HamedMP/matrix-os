// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useWorkRailPage } from "@desktop/renderer/src/features/work/work-rail/useWorkRailPage";
import { AppError } from "@desktop/shared/app-error";

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

it("retains expanded rows when the navigation refreshes", async () => {
  const record = (index: number) => ({ chat: { id: `chat_${index}` } });
  const navigationPage = vi.fn(async (query: { cursor?: string }) => query.cursor
    ? { items: Array.from({ length: 20 }, (_, index) => record(index + 10)), totalCount: 30 }
    : { items: Array.from({ length: 10 }, (_, index) => record(index)), totalCount: 30, nextCursor: "next" });
  const client = { navigationPage } as never;
  const { result, rerender } = renderHook(({ version }) => useWorkRailPage(client, { group: "done" }, "owner/main", version, 10), { initialProps: { version: 0 } });
  await waitFor(() => expect(result.current.rows).toHaveLength(10));
  act(() => result.current.loadMore());
  await waitFor(() => expect(result.current.rows).toHaveLength(30));
  rerender({ version: 1 });
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(result.current.rows).toHaveLength(30);
});

it("drops paged titles and ignores a late page when navigation authority is lost", async () => {
  let finishNext!: (value: unknown) => void;
  const next = new Promise(resolve => { finishNext = resolve; });
  const navigationPage = vi.fn(async (query: { cursor?: string }) => query.cursor ? next
    : { items: Array.from({ length: 10 }, (_, index) => ({ chat: { id: `chat_private_${index}`, title: "Private" } })), totalCount: 11, nextCursor: "next" });
  const client = { navigationPage } as never;
  const { result, rerender } = renderHook(({ allowed }) => useWorkRailPage(allowed ? client : null,
    { group: "done" }, allowed ? "owner:0" : "owner:1", 0, 10), { initialProps: { allowed: true } });
  await waitFor(() => expect(result.current.rows).toHaveLength(10));
  act(() => result.current.loadMore());
  rerender({ allowed: false });
  expect(result.current.rows).toEqual([]);
  await act(async () => finishNext({ items: [{ chat: { id: "chat_private_older", title: "Older" } }], totalCount: 2 }));
  expect(result.current.rows).toEqual([]);
});

it("clears already loaded titles when a later page is forbidden", async () => {
  const navigationPage = vi.fn(async (query: { cursor?: string }) => {
    if (query.cursor) throw new AppError("unauthorized", { httpStatus: 403 });
    return { items: Array.from({ length: 10 }, (_, index) => ({ chat: { id: `chat_private_${index}`, title: "Private title" } })), totalCount: 11, nextCursor: "next" };
  });
  const client = { navigationPage } as never;
  const { result } = renderHook(() => useWorkRailPage(client,
    { group: "done" }, "owner:0", 0, 10));
  await waitFor(() => expect(result.current.rows).toHaveLength(10));
  act(() => result.current.loadMore());
  await waitFor(() => expect(result.current.error).toBe(true));
  expect(result.current.rows).toEqual([]);
});
