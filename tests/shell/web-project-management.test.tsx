// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { WebProjectsNav } from "../../shell/src/components/chat/WebProjectsNav";
import { useWebProjects, type WebProject } from "../../shell/src/components/chat/web-projects";
import { WebProjectAgentContextNavigation } from "../../shell/src/components/chat/WebProjectAgentContext";
import { useFileBrowser } from "../../shell/src/hooks/useFileBrowser";
import { OrganizationStateProvider } from "../../shell/src/lib/collaboration-organization-state";

vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ userId: "user_owner", sessionId: "session_owner" }) }));

const GATEWAY = "https://example.test/vm/main";
type Route = (init: RequestInit | undefined, url: URL) => Response | Promise<Response>;

function gateway(routes: Record<string, Route>) {
  const request = vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    const key = `${init?.method ?? "GET"} ${url.pathname.replace("/vm/main", "")}`;
    const route = routes[key];
    if (!route) return Response.json({ error: { code: "not_found" } }, { status: 404 });
    return route(init, url);
  });
  vi.stubGlobal("fetch", request);
  return request;
}

function bodyOf(request: ReturnType<typeof gateway>, key: string): unknown {
  const call = request.mock.calls.find(([input, init]) => `${init?.method ?? "GET"} ${new URL(input).pathname.replace("/vm/main", "")}` === key);
  return call?.[1]?.body ? JSON.parse(String(call[1].body)) : undefined;
}

function Nav({ onFocusProject = vi.fn(), gatewayUrl = GATEWAY, placement }: { onFocusProject?: (project: WebProject) => void; gatewayUrl?: string; placement?: "pinned" }) {
  const state = useWebProjects(gatewayUrl, "owner/main");
  return <WebProjectsNav state={state} gatewayUrl={gatewayUrl} chats={[]} listedChatIds={new Set()} onSelectChat={vi.fn()}
    onFocusProject={onFocusProject} renderChat={() => null} placement={placement} />;
}

async function openMenuItem(project: string, item: string) {
  fireEvent.keyDown(await screen.findByRole("button", { name: `Actions for ${project}` }), { key: "Enter" });
  fireEvent.click(await screen.findByRole("menuitem", { name: item }));
}

function listCalls(request: ReturnType<typeof gateway>) {
  return request.mock.calls.filter(([url]) => url.includes("/api/workspace/projects")).length;
}

function listOf(...lists: unknown[][]): Route {
  let index = 0;
  return () => Response.json({ projects: lists[Math.min(index++, lists.length - 1)], nextCursor: null });
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const france = { id: "proj_france", slug: "france", name: "France", kind: "scratch" };

it("opens the add-project dialog from the empty Projects state", async () => {
  gateway({ "GET /api/workspace/projects": listOf([]) });
  render(<Nav />);
  fireEvent.click(await screen.findByRole("button", { name: "Create your first project" }));
  const dialog = await screen.findByRole("dialog");
  expect(within(dialog).getByRole("button", { name: /Existing folder/ })).toBeTruthy();
  expect(within(dialog).getByRole("button", { name: /Clone from GitHub/ })).toBeTruthy();
  expect(within(dialog).getByRole("button", { name: /New folder/ })).toBeTruthy();
});

it("creates a new folder project, lists it, and opens its page", async () => {
  const request = gateway({
    "GET /api/workspace/projects": listOf([], [france]),
    "POST /api/projects": () => Response.json({ project: france }, { status: 201 }),
  });
  const focus = vi.fn();
  render(<Nav onFocusProject={focus} />);
  fireEvent.click(await screen.findByRole("button", { name: "Create project" }));
  fireEvent.change(screen.getByLabelText("What are you working on?"), { target: { value: "France" } });
  fireEvent.click(screen.getByRole("button", { name: /New folder/ }));
  fireEvent.click(screen.getByRole("button", { name: "Create" }));
  await waitFor(() => expect(focus).toHaveBeenCalledWith(expect.objectContaining({ id: "proj_france", slug: "france" })));
  expect(bodyOf(request, "POST /api/projects")).toMatchObject({ name: "France", mode: "scratch", clientRequestId: expect.stringMatching(/^req_/) });
  expect(await screen.findByRole("button", { name: "Expand France chats" })).toBeTruthy();
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("clones a GitHub repository with the derived folder name", async () => {
  const clone = { id: "proj_repo", slug: "repo", name: "Repo", kind: "github" };
  const request = gateway({
    "GET /api/workspace/projects": listOf([], [clone]),
    "POST /api/projects/clone": () => Response.json({ project: clone }, { status: 201 }),
  });
  const focus = vi.fn();
  render(<Nav onFocusProject={focus} />);
  fireEvent.click(await screen.findByRole("button", { name: "Create project" }));
  fireEvent.change(screen.getByLabelText("What are you working on?"), { target: { value: "Repo" } });
  fireEvent.click(screen.getByRole("button", { name: /Clone from GitHub/ }));
  fireEvent.change(screen.getByPlaceholderText("https://github.com/owner/repo"), { target: { value: "https://github.com/acme/repo.git" } });
  fireEvent.click(screen.getByRole("button", { name: "Clone" }));
  await waitFor(() => expect(focus).toHaveBeenCalledWith(expect.objectContaining({ slug: "repo" })));
  expect(bodyOf(request, "POST /api/projects/clone")).toMatchObject({
    url: "https://github.com/acme/repo.git", name: "repo", displayName: "Repo", clientRequestId: expect.stringMatching(/^req_/),
  });
});

it("connects an existing folder chosen on the Matrix computer", async () => {
  const connected = { id: "proj_site", slug: "site", name: "site", kind: "folder", localPath: "code/site" };
  const request = gateway({
    "GET /api/workspace/projects": listOf([], [connected]),
    "GET /api/files/list": (_init, url) => Response.json({ entries: url.searchParams.get("path") === ""
      ? [{ name: "code", type: "directory" }, { name: "notes.md", type: "file" }]
      : url.searchParams.get("path") === "code" ? [{ name: "site", type: "directory" }] : [] }),
    "POST /api/projects": () => Response.json({ project: connected }, { status: 201 }),
  });
  const focus = vi.fn();
  render(<Nav onFocusProject={focus} />);
  fireEvent.click(await screen.findByRole("button", { name: "Create project" }));
  fireEvent.click(screen.getByRole("button", { name: /Existing folder/ }));
  fireEvent.click(await screen.findByRole("button", { name: "Open code" }));
  expect(screen.queryByRole("button", { name: "Open notes.md" })).toBeNull();
  fireEvent.click(await screen.findByRole("button", { name: "Open site" }));
  fireEvent.click(await screen.findByRole("button", { name: "Choose site" }));
  expect(screen.getByText("Selected: code/site")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Create" }));
  await waitFor(() => expect(focus).toHaveBeenCalledWith(expect.objectContaining({ slug: "site" })));
  expect(bodyOf(request, "POST /api/projects")).toMatchObject({ name: "site", mode: "folder", path: "code/site" });
});

it("keeps the dialog open with allowlisted copy when the gateway rejects a clone", async () => {
  gateway({
    "GET /api/workspace/projects": listOf([]),
    "POST /api/projects/clone": () => Response.json({ error: { code: "slug_conflict", message: "EEXIST /home/matrix/home/projects/repo" } }, { status: 409 }),
  });
  const focus = vi.fn();
  render(<Nav onFocusProject={focus} />);
  fireEvent.click(await screen.findByRole("button", { name: "Create project" }));
  fireEvent.change(screen.getByLabelText("What are you working on?"), { target: { value: "Repo" } });
  fireEvent.click(screen.getByRole("button", { name: /Clone from GitHub/ }));
  fireEvent.change(screen.getByPlaceholderText("https://github.com/owner/repo"), { target: { value: "https://github.com/acme/repo" } });
  fireEvent.click(screen.getByRole("button", { name: "Clone" }));
  expect(await screen.findByText("A project with that name already exists. Choose a different folder name.")).toBeTruthy();
  expect(screen.getByRole("dialog")).toBeTruthy();
  expect(screen.queryByText(/EEXIST/)).toBeNull();
  expect(focus).not.toHaveBeenCalled();
});

it("keeps the project until the gateway confirms deletion", async () => {
  let deleteResponse: Response = Response.json({ error: { code: "project_active", message: "worker pid 42 still running" } }, { status: 409 });
  const request = gateway({
    "GET /api/workspace/projects": listOf([france], []),
    "POST /api/projects/france/actions": () => deleteResponse,
  });
  render(<Nav />);
  fireEvent.keyDown(await screen.findByRole("button", { name: "Actions for France" }), { key: "Enter" });
  fireEvent.click(await screen.findByRole("menuitem", { name: "Delete project" }));
  const dialog = await screen.findByRole("alertdialog");
  const confirm = within(dialog).getByRole("button", { name: "Delete project" });
  expect(confirm).toHaveProperty("disabled", true);
  fireEvent.change(within(dialog).getByLabelText("Type France to confirm"), { target: { value: "France" } });
  fireEvent.click(confirm);
  expect(await within(dialog).findByRole("alert")).toHaveProperty("textContent", "Stop active project work before continuing.");
  expect(screen.queryByText(/pid 42/)).toBeNull();
  // The project stays listed (behind the modal) until the gateway confirms.
  expect(screen.getByRole("button", { name: "Expand France chats", hidden: true })).toBeTruthy();
  expect(request.mock.calls.filter(([url]) => url.includes("/api/workspace/projects"))).toHaveLength(1);

  deleteResponse = Response.json({ ok: true });
  fireEvent.click(within(dialog).getByRole("button", { name: "Delete project" }));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(bodyOf(request, "POST /api/projects/france/actions")).toEqual({ type: "delete", confirmation: "France", confirmTerminate: true });
  await waitFor(() => expect(screen.queryByRole("button", { name: "Expand France chats" })).toBeNull());
  expect(await screen.findByText("No projects on this computer yet.")).toBeTruthy();
});

it("opens the existing project instead of connecting an already connected folder twice", async () => {
  const website = { id: "proj_website", slug: "website", name: "Website", kind: "folder", localPath: "code/site" };
  const request = gateway({
    "GET /api/workspace/projects": listOf([website]),
    "GET /api/files/list": (_init, url) => Response.json({ entries: url.searchParams.get("path") === ""
      ? [{ name: "code", type: "directory" }] : url.searchParams.get("path") === "code" ? [{ name: "site", type: "directory" }] : [] }),
  });
  const focus = vi.fn();
  render(<Nav onFocusProject={focus} />);
  fireEvent.click(await screen.findByRole("button", { name: "Create project" }));
  fireEvent.click(screen.getByRole("button", { name: /Existing folder/ }));
  fireEvent.click(await screen.findByRole("button", { name: "Open code" }));
  fireEvent.click(await screen.findByRole("button", { name: "Open site" }));
  expect(await screen.findByText("This folder is already connected to Matrix OS.")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Open Website" }));
  await waitFor(() => expect(focus).toHaveBeenCalledWith(expect.objectContaining({ id: "proj_website" })));
  expect(request.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
});

it("pins a project only after the gateway saves it, and lists it under Pinned", async () => {
  let patch: Response = Response.json({ error: { code: "write_failed", message: "EACCES /home/matrix" } }, { status: 500 });
  const request = gateway({
    "GET /api/workspace/projects": listOf([france], [{ ...france, pinned: true }]),
    "PATCH /api/projects/france": () => patch,
  });
  const view = render(<Nav />);
  await openMenuItem("France", "Pin");
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", "The project could not be updated. Try again.");
  expect(screen.queryByText(/EACCES/)).toBeNull();
  expect(listCalls(request)).toBe(1);

  patch = Response.json({ project: { ...france, pinned: true } });
  await openMenuItem("France", "Pin");
  await waitFor(() => expect(listCalls(request)).toBe(2));
  expect(bodyOf(request, "PATCH /api/projects/france")).toEqual({ pinned: true });
  await waitFor(() => expect(screen.queryByRole("button", { name: "Expand France chats" })).toBeNull());
  view.rerender(<Nav placement="pinned" />);
  await openMenuItem("France", "Unpin");
});

it("edits the project name and description, keeping the dialog open on failure", async () => {
  let patch: Response = Response.json({ error: { code: "write_failed" } }, { status: 500 });
  const request = gateway({
    "GET /api/workspace/projects": listOf([{ ...france, description: "Old" }], [{ ...france, name: "Paris" }]),
    "PATCH /api/projects/france": () => patch,
  });
  render(<Nav />);
  await openMenuItem("France", "Edit");
  const dialog = await screen.findByRole("dialog");
  fireEvent.change(within(dialog).getByLabelText("Project name"), { target: { value: "Paris" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
  expect(await within(dialog).findByRole("alert")).toHaveProperty("textContent", "The project could not be updated. Try again.");
  expect(listCalls(request)).toBe(1);

  patch = Response.json({ project: { ...france, name: "Paris" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(bodyOf(request, "PATCH /api/projects/france")).toEqual({ name: "Paris", description: "Old" });
  expect(await screen.findByRole("button", { name: "Expand Paris chats" })).toBeTruthy();
});

it("shows the project folder in the built-in Files app", async () => {
  const origin = window.location.origin;
  gateway({
    "GET /api/workspace/projects": listOf([france]),
    "GET /api/projects/france/files-location": () => Response.json({ path: "projects/france" }),
  });
  const openFiles = vi.fn();
  useFileBrowser.setState({ pendingView: null, pendingFolder: null });
  render(<WebProjectAgentContextNavigation.Provider value={{ openFiles, openMcpSettings: vi.fn() }}>
    <Nav gatewayUrl={origin} />
  </WebProjectAgentContextNavigation.Provider>);
  await openMenuItem("France", "Show in Files");
  await waitFor(() => expect(openFiles).toHaveBeenCalledOnce());
  expect(useFileBrowser.getState().pendingFolder).toMatchObject({ path: "projects/france" });
  expect(useFileBrowser.getState().pendingView).toBe("files");
});

it("offers whole-project sharing to organization members", async () => {
  gateway({
    "GET /api/workspace/projects": listOf([france]),
    "GET /api/system/info": () => Response.json({
      runtime: { handle: "owner", runtimeSlot: "primary", machineId: "6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b" },
      capabilities: { collaboration: true },
    }),
  });
  const view = render(<OrganizationStateProvider value={{ status: "member", organizationId: "org_team" }}><Nav /></OrganizationStateProvider>);
  fireEvent.keyDown(await screen.findByRole("button", { name: "Actions for France" }), { key: "Enter" });
  expect(await screen.findByRole("menuitem", { name: "Share project" })).toBeTruthy();
  view.unmount();
  render(<OrganizationStateProvider value={{ status: "none", organizationId: null }}><Nav /></OrganizationStateProvider>);
  fireEvent.keyDown(await screen.findByRole("button", { name: "Actions for France" }), { key: "Enter" });
  await screen.findByRole("menuitem", { name: "Edit" });
  expect(screen.queryByRole("menuitem", { name: /Share/ })).toBeNull();
});
