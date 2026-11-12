// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useSharedAppDirectory } from "../../packages/ui/src/collaboration/useSharedAppDirectory.js";
import { notifyCollaborationDiscoveryChanged } from "../../packages/ui/src/collaboration/discovery-events.js";
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
