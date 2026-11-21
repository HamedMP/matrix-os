// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { WebProjectsNav } from "../../shell/src/components/chat/WebProjectsNav";
import { useWebProjects, type WebProject } from "../../shell/src/components/chat/web-projects";

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

function Nav({ onFocusProject = vi.fn() }: { onFocusProject?: (project: WebProject) => void }) {
  const state = useWebProjects(GATEWAY, "owner/main");
  return <WebProjectsNav state={state} gatewayUrl={GATEWAY} chats={[]} listedChatIds={new Set()} onSelectChat={vi.fn()}
    onFocusProject={onFocusProject} renderChat={() => null} />;
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
