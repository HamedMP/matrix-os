// @vitest-environment jsdom

import React from "react";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SharedWorkRailProjects } from "../../desktop/src/renderer/src/features/work/work-rail/SharedWorkRailProjects";
import { notifyCollaborationDiscoveryChanged } from "../../packages/ui/src/collaboration/discovery-events";
import { useConnection } from "../../desktop/src/renderer/src/stores/connection";
import { useTabs } from "../../desktop/src/renderer/src/stores/tabs";

const projectScope = "10000000-0000-4000-8000-000000000a01";
const chatScope = "10000000-0000-4000-8000-000000000c01";
const scope = {
  id: projectScope, ownerId: "user_owner", kind: "project", resourceId: "proj_542a8126",
  membershipMode: "direct", lifecycle: "shared", revision: "5", authEpoch: "1", authorityGeneration: "1",
  role: "editor",
  capabilities: { read: true, discuss: true, manageMembers: false, requestAi: false, observeTerminal: false, controlTerminal: false, stopTerminal: false },
} as const;
const mock = vi.hoisted(() => ({
  items: [] as unknown[],
  pages: null as null | Array<{ items: unknown[]; nextCursor?: string } | "fail">,
  fail: false,
  calls: 0,
  paths: [] as string[],
  gate: null as null | Promise<void>,
  created: 0,
  released: [] as number[],
}));

vi.mock("../../desktop/src/renderer/src/lib/collaboration", () => ({
  createDesktopCollaborationApi: () => {
    mock.created += 1;
    const id = mock.created;
    return {
      id,
      baseUrl: "https://app.matrix-os.com",
      get: vi.fn(async (path: string) => {
        mock.calls += 1;
        mock.paths.push(path);
        const gate = mock.gate;
        if (gate) await gate;
        if (mock.fail) throw new Error("SharedUnavailable");
        if (!path.startsWith("/api/collaboration/shared")) throw new Error("UnexpectedRequest");
        if (!mock.pages) return { items: mock.items };
        const cursor = new URL(path, "https://x").searchParams.get("cursor");
        const page = mock.pages[cursor ? Number(cursor) : 0];
        if (page === "fail") throw new Error("PageUnavailable");
        return page;
      }),
      post: vi.fn(),
      delete: vi.fn(),
    };
  },
  releaseDesktopCollaborationApi: (api: { id: number }) => { mock.released.push(api.id); },
}));

function sharedProject(overrides: Record<string, unknown> = {}) {
  return {
    scopeId: projectScope, runtimeId: "vps:11111111-1111-4111-8111-111111111111", ownerId: "user_owner",
    kind: "project", authorityGeneration: 1, status: "accepted",
    resource: {
      scope,
      project: { id: "proj_542a8126", scopeId: projectScope, status: "active", resources: [] },
      overview: {
        projectId: "proj_542a8126", scopeId: projectScope, name: "collab testing 12PMOct3", status: "active",
        chats: [{ scopeId: chatScope, chatId: "chat_release", title: "Release plan", updatedAt: "2026-10-03T12:00:00.000Z" }],
      },
    },
    ...overrides,
  };
}

describe("Electron Work rail shared projects", () => {
  beforeEach(() => {
    mock.items = [sharedProject()];
    mock.pages = null;
    mock.fail = false;
    mock.calls = 0;
    mock.paths = [];
    mock.gate = null;
    mock.created = 0;
    mock.released = [];
    useConnection.setState({ ...useConnection.getInitialState(), userId: "user_member", platformHost: "https://app.matrix-os.com" }, true);
    useTabs.setState({ ...useTabs.getInitialState(), tabs: [], activeTabId: null }, true);
  });

  afterEach(cleanup);

  it("lists an accepted shared project like an own project, marked as shared, with no owner actions", async () => {
    render(<SharedWorkRailProjects />);
    const project = await screen.findByRole("button", { name: "collab testing 12PMOct3" });
    expect(project).toHaveAttribute("aria-expanded", "false");
    expect(within(project).getByRole("img", { name: "Shared project" })).toBeInTheDocument();
    expect(screen.queryByText("proj_542a8126")).toBeNull();
    expect(screen.queryByRole("button", { name: /Project actions|New chat in/ })).toBeNull();
    fireEvent.contextMenu(project);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("expands to its Chats and opens a Chat as a shared Chat tab", async () => {
    render(<SharedWorkRailProjects />);
    fireEvent.click(await screen.findByRole("button", { name: "collab testing 12PMOct3" }));
    fireEvent.click(screen.getByRole("button", { name: "Release plan" }));
    const tab = useTabs.getState().tabs.find((candidate) => candidate.sharedScopeId === chatScope);
    // Shared Chats open in the Work tab, as they do from Shared with me.
    expect(tab).toMatchObject({ kind: "work", workRoute: "chat", chatId: "chat_release", chatTitle: "Release plan", sharedScopeId: chatScope });
    expect(useTabs.getState().activeTabId).toBe(tab!.id);
    expect(screen.getByRole("button", { name: "Release plan" })).toHaveAttribute("aria-current", "page");
  });

  it("reveals a newly accepted project in the rail without opening a project surface", async () => {
    const { rerender } = render(<SharedWorkRailProjects revealRequest={{ scopeId: projectScope, requestId: 1 }} />);

    const project = await screen.findByRole("button", { name: "collab testing 12PMOct3" });
    expect(project).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: "Release plan" })).toBeVisible();
    expect(useTabs.getState().tabs).toEqual([]);

    fireEvent.click(project);
    expect(project).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(project);
    expect(project).toHaveAttribute("aria-expanded", "true");
    rerender(<SharedWorkRailProjects revealRequest={{ scopeId: projectScope, requestId: 2 }} />);
    expect(project).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(project);
    expect(project).toHaveAttribute("aria-expanded", "false");
  });

  it("lists only accepted projects with an overview, and refreshes when sharing changes", async () => {
    mock.items = [
      { scopeId: "10000000-0000-4000-8000-000000000a04", runtimeId: "vps:11111111-1111-4111-8111-111111111111",
        ownerId: "user_owner", kind: "project", authorityGeneration: 1, status: "organization_pending",
        organizationId: "org_1", grantId: "50000000-0000-4000-8000-000000000001" },
      sharedProject({ resource: { ...sharedProject().resource, overview: undefined } }),
      { ...sharedProject({ scopeId: "10000000-0000-4000-8000-000000000a03", home: "offline" }), resource: undefined },
    ];
    const warn = vi.spyOn(console, "warn");
    render(<SharedWorkRailProjects />);
    await act(async () => { await Promise.resolve(); });
    expect(screen.queryAllByRole("button")).toEqual([]);
    // The page itself was valid: these items were filtered, not dropped by a failed load.
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
    mock.items = [sharedProject()];
    await act(async () => { notifyCollaborationDiscoveryChanged(); await Promise.resolve(); });
    expect(await screen.findByRole("button", { name: "collab testing 12PMOct3" })).toBeVisible();
  });

  it("skips an invalid item instead of hiding every shared project", async () => {
    mock.items = [{ ...sharedProject(), scopeId: "10000000-0000-4000-8000-000000000a09" }, sharedProject()];
    render(<SharedWorkRailProjects />);
    expect(await screen.findAllByRole("button", { name: "collab testing 12PMOct3" })).toHaveLength(1);
  });

  it("uses a fresh connection after the account signs in again, and releases the old one", async () => {
    const { unmount } = render(<SharedWorkRailProjects />);
    expect(await screen.findByRole("button", { name: "collab testing 12PMOct3" })).toBeVisible();
    await act(async () => { useConnection.setState({ authGeneration: useConnection.getState().authGeneration + 1 }); });
    expect(await screen.findByRole("button", { name: "collab testing 12PMOct3" })).toBeVisible();
    expect(mock.created).toBe(2);
    expect(mock.released).toEqual([1]);
    unmount();
    expect(mock.released).toEqual([1, 2]);
  });

  it("finds shared projects on later pages of shared items", async () => {
    const chatOnly = { scopeId: "10000000-0000-4000-8000-000000000b01", runtimeId: "vps:11111111-1111-4111-8111-111111111111",
      ownerId: "user_owner", kind: "chat", authorityGeneration: 1, status: "accepted", home: "offline" };
    mock.pages = [{ items: [chatOnly], nextCursor: "1" }, { items: [sharedProject()] }];
    render(<SharedWorkRailProjects />);
    expect(await screen.findByRole("button", { name: "collab testing 12PMOct3" })).toBeVisible();
    expect(mock.paths).toEqual(["/api/collaboration/shared?limit=50", "/api/collaboration/shared?limit=50&cursor=1"]);
  });

  it("keeps projects from pages that loaded when a later page fails", async () => {
    mock.pages = [{ items: [sharedProject()], nextCursor: "1" }, "fail"];
    render(<SharedWorkRailProjects />);
    expect(await screen.findByRole("button", { name: "collab testing 12PMOct3" })).toBeVisible();
    expect(mock.paths).toHaveLength(2);
  });

  it("reloads once more when sharing changes during a load, instead of dropping the change", async () => {
    let release!: () => void;
    mock.gate = new Promise<void>((resolve) => { release = resolve; });
    mock.items = [];
    render(<SharedWorkRailProjects />);
    await act(async () => { await Promise.resolve(); });
    mock.items = [sharedProject()];
    act(() => notifyCollaborationDiscoveryChanged());
    mock.gate = null;
    await act(async () => { release(); await Promise.resolve(); });
    expect(await screen.findByRole("button", { name: "collab testing 12PMOct3" })).toBeVisible();
    expect(mock.calls).toBe(2);
  });

  it("renders nothing when shared projects cannot be loaded or the account is disconnected", async () => {
    mock.fail = true;
    const { unmount } = render(<SharedWorkRailProjects />);
    await act(async () => { await Promise.resolve(); });
    expect(screen.queryAllByRole("button")).toEqual([]);
    unmount();
    mock.fail = false;
    useConnection.setState({ userId: null } as never);
    render(<SharedWorkRailProjects />);
    await act(async () => { await Promise.resolve(); });
    expect(mock.calls).toBe(1);
    expect(screen.queryAllByRole("button")).toEqual([]);
  });
});
