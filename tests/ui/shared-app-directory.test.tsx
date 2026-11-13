// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useSharedAppDirectory } from "../../packages/ui/src/collaboration/useSharedAppDirectory.js";
import { notifyCollaborationDiscoveryChanged } from "../../packages/ui/src/collaboration/discovery-events.js";
import { SharedAppDirectoryNotice } from "../../packages/ui/src/collaboration/SharedAppDirectoryNotice.js";
import { MobileLauncher } from "../../shell/src/components/mobile/MobileLauncher.js";

const target = {
  scopeId: "10000000-0000-4000-8000-000000000001", runtimeId: "runtime_owner",
  organizationId: "org_team", authorityGeneration: 1, appId: "shared-tasks-lab",
  catalogId: "30000000-0000-4000-8000-000000000001", readinessId: "40000000-0000-4000-8000-000000000001",
  registrationIncarnation: "a".repeat(64), buildId: "b".repeat(64), shareRevision: "1",
  owner: { actorId: "user_owner", displayName: "Owner" },
};
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it("loads every metadata page and removes a stopped share on discovery refresh", async () => {
  let shared = true;
  const api = { get: vi.fn(async (path: string) => !shared ? { items: [] }
    : path.includes("cursor=") ? { items: [target] } : { items: [], nextCursor: "next" }) };
  const { result } = renderHook(() => useSharedAppDirectory(api, "user_member"));
  await waitFor(() => expect(result.current.items).toEqual([target]));
  expect(api.get).toHaveBeenCalledWith("/api/collaboration/shared-apps?limit=100&cursor=next");
  shared = false;
  act(() => notifyCollaborationDiscoveryChanged());
  await waitFor(() => expect(result.current.items).toEqual([]));
});

it("discards late discovery responses after switching accounts", async () => {
  let complete!: (value: unknown) => void;
  const api = { get: vi.fn().mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }))
    .mockResolvedValue({ items: [] }) };
  const { result, rerender } = renderHook(({ identity }) => useSharedAppDirectory(api, identity), {
    initialProps: { identity: "user_first" },
  });
  rerender({ identity: "user_second" });
  await act(async () => { complete({ items: [target] }); });
  expect(result.current.items).toEqual([]);
});

it("reports a discovery failure and retries without treating it as an empty success", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const api = { get: vi.fn().mockRejectedValueOnce(new Error("network unavailable")).mockResolvedValue({ items: [target] }) };
  const { result } = renderHook(() => useSharedAppDirectory(api, "user_member"));
  await waitFor(() => expect(result.current.unavailable).toBe(true));
  act(() => result.current.retry());
  await waitFor(() => expect(result.current.items).toEqual([target]));
  expect(result.current.unavailable).toBe(false);
});

it("marks and opens a shared app in the Web Mobile launcher", () => {
  const app = { id: "shared:tasks", name: "Shared tasks lab", path: `__shared-app__:${target.scopeId}`,
    iconSlug: "apps", sharedAppTarget: target };
  const open = vi.fn();
  render(<MobileLauncher apps={[app]} onOpen={open} onOpenSettings={() => undefined}
    openStackCount={0} onShowSwitcher={() => undefined} onCloseAll={() => undefined} />);
  const tile = screen.getByRole("button", { name: /Shared tasks lab/ });
  expect(tile.querySelector('[aria-label="Shared app"]')).toBeTruthy();
  fireEvent.click(tile);
  expect(open).toHaveBeenCalledWith(app);
});

it("keeps a large directory usable and loads additional pages on demand", async () => {
  const api = { get: vi.fn(async (path: string) => {
    const page = Number(new URL(path, "https://platform.test").searchParams.get("cursor") ?? 0);
    return { items: [{ ...target, scopeId: `10000000-0000-4000-8000-${String(page + 1).padStart(12, "0")}` }],
      ...(page < 20 ? { nextCursor: String(page + 1) } : {}) };
  }) };
  const { result } = renderHook(() => useSharedAppDirectory(api, "user_member"));
  await waitFor(() => expect(result.current.items).toHaveLength(20));
  expect(result.current.unavailable).toBe(false);
  expect(result.current.hasMore).toBe(true);
  act(() => result.current.loadMore());
  await waitFor(() => expect(result.current.items).toHaveLength(21));
  expect(result.current.hasMore).toBe(false);
});

it("bounds loaded entries, preserves them on pagination failure and offers restart", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  let failNext = true;
  const api = { get: vi.fn(async (path: string) => {
    const page = Number(new URL(path, "https://platform.test").searchParams.get("cursor") ?? 0);
    if (page === 20 && failNext) { failNext = false; throw new Error("network unavailable"); }
    return { items: Array.from({ length: 100 }, (_, index) => ({ ...target,
      scopeId: `10000000-0000-4000-8000-${String(page * 100 + index + 1).padStart(12, "0")}` })),
      ...(page < 20 ? { nextCursor: String(page + 1) } : {}) };
  }) };
  let count = 0;
  let first = "";
  function Directory() {
    const directory = useSharedAppDirectory(api, "user_member");
    count = directory.items.length;first = directory.items[0]?.scopeId ?? "";
    return <SharedAppDirectoryNotice directory={directory} />;
  }
  render(<Directory />);
  fireEvent.click(await screen.findByRole("button", { name: "Load more shared apps" }));
  fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Show first shared apps" })).toBeTruthy());
  expect(count).toBe(2_000);
  expect(first).toBe("10000000-0000-4000-8000-000000000101");
  fireEvent.click(screen.getByRole("button", { name: "Show first shared apps" }));
  await screen.findByRole("button", { name: "Load more shared apps" });
  expect(count).toBe(2_000);
  expect(first).toBe(target.scopeId);
});
