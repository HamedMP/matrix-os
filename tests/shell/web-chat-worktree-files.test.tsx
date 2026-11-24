// @vitest-environment jsdom
import React from "react";
import { mkdtemp, mkdir, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { ChatApp } from "../../shell/src/components/ChatApp";
import "../../shell/src/components/preview-window/CodeEditor";

vi.mock("@/hooks/useSocket", () => ({ useSocket: () => ({ connected: true, subscribe: () => () => {}, send: vi.fn() }) }));
vi.mock("@clerk/nextjs", () => ({ useOrganization: () => ({ organization: null }), useAuth: () => ({ userId: null, sessionId: null }) }));
vi.mock("../../shell/src/components/chat-provider-onboarding", () => ({ ChatProviderOnboarding: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); localStorage.clear(); });

it("browses and previews the owner's run worktree through the real Gateway file boundaries", async () => {
  // Keep server imports in Node: Vite's browser asset rewrite changes native
  // launch shim file URLs into HTTP URLs. No file route or filesystem is mocked.
  // jsdom and Node expose different typed-array realms. esbuild checks that
  // its native TextEncoder matches Uint8Array before starting the TS loader.
  vi.stubGlobal("Uint8Array", new TextEncoder().encode("").constructor);
  const { tsImport } = await import("tsx/esm/api");
  const [{ createProjectManager }, { createCodingAgentFilePreviewWiring }, { createFilePreviewRoutes }, { createCodingAgentRoutes }] = await Promise.all([
    tsImport("../../packages/gateway/src/project-manager.ts", import.meta.url),
    tsImport("../../packages/gateway/src/coding-agents/file-preview-wiring.ts", import.meta.url),
    tsImport("../../packages/gateway/src/file-preview-routes.ts", import.meta.url),
    tsImport("../../packages/gateway/src/coding-agents/routes.ts", import.meta.url),
  ]);
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  const homePath = await realpath(await mkdtemp(join(tmpdir(), "eng461-worktree-web-")));
  try {
    const manager = createProjectManager({ homePath });
    const created = await manager.createProject({ name: "Worktree project", slug: "worktree-project", mode: "scratch", ownerScope: { type: "user", id: "owner" }, clientRequestId: "req_worktree_web" });
    if (!created.ok) throw new Error("Project fixture failed");
    const project = created.project;
    const worktreeRoot = join(homePath, "worktrees", "wt_111111111111");
    await mkdir(worktreeRoot, { recursive: true });
    await mkdir(join(project.localPath, "src"), { recursive: true });
    await mkdir(join(worktreeRoot, "src"), { recursive: true });
    await writeFile(join(project.localPath, "src/shared.txt"), "Main branch value");
    await writeFile(join(worktreeRoot, "src/shared.txt"), "Worktree branch value");
    await writeFile(join(worktreeRoot, "only-in-worktree.txt"), "New branch file");
    const listWorktrees = vi.fn(async (slug: string, owner: { type: "user"; id: string }) => {
      expect(slug).toBe(project.slug); expect(owner).toEqual({ type: "user", id: "owner" });
      return { ok: true as const, worktrees: [{ id: "wt_111111111111", path: worktreeRoot }] };
    });
    const { filePreviewService, codingAgentFileStore } = createCodingAgentFilePreviewWiring({ homePath, ownerId: "owner", projects: { getProjectBySlug: slug => manager.getProject(slug) }, worktrees: { listWorktrees } });
    const principal = { userId: "owner", source: "jwt" as const };
    const app = new Hono()
      .route("/api/file-previews", createFilePreviewRoutes({ service: filePreviewService, getPrincipal: () => principal }))
      .route("/api/coding-agents", createCodingAgentRoutes({ service: { getSummary: vi.fn() } as never, files: codingAgentFileStore, getPrincipal: () => principal }));
    const request = vi.fn(async (url: string) => {
      const parsed = new URL(url, window.location.origin);
      if (parsed.pathname.startsWith("/api/file-previews/") || parsed.pathname.startsWith("/api/coding-agents/files/")) return app.request(parsed.pathname + parsed.search);
      if (parsed.pathname.endsWith("/workspace/projects")) return Response.json({ projects: [project] });
      if (parsed.pathname.endsWith("/files-location")) return Response.json({ path: "projects/worktree-project/repo" });
      if (parsed.pathname.endsWith("/files/list")) return Response.json({ entries: [{ name: "src", type: "directory" }] });
      return Response.json({ entries: [] });
    }); vi.stubGlobal("fetch", request);
    const chat = <ChatApp messages={[{ id: "worktree_message", role: "assistant", content: "Changed `src/shared.txt`.", timestamp: 1 }]}
      sessionId="chat_worktree" chatProjectId={project.id} chatFileScope={{ kind: "project", projectId: project.id, worktreeId: "wt_111111111111" }}
      busy={false} connected conversations={[]} onNewChat={vi.fn()} onSwitchConversation={vi.fn()} onSubmit={vi.fn()}
      sideChatClient={{ getSideChat: vi.fn(async () => ({ threadId: null, messages: [] })), createSideChat: vi.fn(), askSideChat: vi.fn() }} />;
    const view = render(chat);
    await screen.findByRole("button", { name: "Expand Worktree project chats" });
    fireEvent.click(await screen.findByRole("button", { name: "Open shared.txt" }));
    await waitFor(() => expect(request.mock.calls.some(([url]) => url.includes("/api/file-previews/"))).toBe(true));
    const firstPreview = request.mock.calls.map(([url]) => new URL(url, window.location.origin)).find(url => url.pathname.startsWith("/api/file-previews/"))!;
    expect(firstPreview.searchParams.get("worktreeId")).toBe("wt_111111111111");
    expect(await screen.findByText("Worktree branch value")).toBeTruthy();
    expect(await screen.findByRole("treeitem", { name: "only-in-worktree.txt", exact: true })).toBeTruthy();
    expect(screen.queryByText("Main branch value")).toBeNull();
    expect(listWorktrees).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Filter files", exact: true }));
    fireEvent.change(screen.getByRole("searchbox", { name: "Filter files" }), { target: { value: "only-in-worktree" } });
    fireEvent.click(await screen.findByRole("button", { name: "Open search result only-in-worktree.txt" }));
    expect(await screen.findByText("New branch file")).toBeTruthy();
    expect(request.mock.calls.some(([url]) => url.includes("/api/coding-agents/files/search?"))).toBe(true);
    const reads = request.mock.calls.map(([url]) => new URL(url, window.location.origin)).filter(url => url.pathname.startsWith("/api/file-previews/"));
    expect(reads.length).toBeGreaterThanOrEqual(2);
    expect(reads.every(url => url.searchParams.get("projectId") === project.slug && url.searchParams.get("worktreeId") === "wt_111111111111")).toBe(true);
    view.rerender(React.cloneElement(chat, { chatFileScope: { kind: "unavailable" } }));
    expect(screen.queryByText("New branch file")).toBeNull();
    expect(screen.getByText("Project files are unavailable.")).toBeTruthy();
    const previousReads = request.mock.calls.filter(([url]) => url.includes("/file-previews/")).length;
    fireEvent.click(screen.getByRole("button", { name: "Open shared.txt" }));
    await act(async () => { await Promise.resolve(); });
    expect(request.mock.calls.filter(([url]) => url.includes("/file-previews/"))).toHaveLength(previousReads);
    expect(request.mock.calls.some(([url]) => url.includes("/files-location"))).toBe(false);
  } finally { cleanup(); await rm(homePath, { recursive: true, force: true }); }
});
