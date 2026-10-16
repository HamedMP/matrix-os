// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import React from "react";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { brainShellError } from "@matrix-os/ui";
import DesktopBrainView from "../../desktop/src/renderer/src/features/brain/DesktopBrainView";
import { desktopBrainTransport } from "../../desktop/src/renderer/src/features/brain/brain-transport";
import { AppError } from "../../desktop/src/shared/app-error";
import type { ApiClient } from "../../desktop/src/renderer/src/lib/api";
import { useConnection } from "../../desktop/src/renderer/src/stores/connection";

const PROJECTS = { projects: [{ id: "proj_matrix_os", name: "Matrix OS", slug: "matrix-os" }] };

/** One fake gateway client per runtime slot; `forRuntime` hands out the slot's own client. */
function fakeApi(answers: Readonly<Record<string, () => Promise<unknown>>> = {}) {
  const slots = new Map<string, ApiClient>();
  const forSlot = (slot: string): ApiClient => {
    const known = slots.get(slot);
    if (known) return known;
    const answer = answers[slot] ?? (async () => PROJECTS);
    const client = {
      get: vi.fn(answer), post: vi.fn(async () => ({})), patch: vi.fn(async () => ({})),
      delete: vi.fn(async () => ({})), forRuntime: vi.fn(forSlot),
      // The brain chat's event stream stays open and silent here.
      openStream: vi.fn(() => new Promise(() => undefined)),
    } as unknown as ApiClient;
    slots.set(slot, client);
    return client;
  };
  return { root: forSlot("root"), slot: forSlot };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}

beforeEach(() => {
  useConnection.setState(useConnection.getInitialState(), true);
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("desktop brain transport", () => {
  it("sends the desktop delete with an empty body and keeps each call's timeout", async () => {
    const api = fakeApi().slot("primary");
    const transport = desktopBrainTransport(api);
    await transport.get("/api/brain/projects/p/sources", { timeoutMs: 15_000 });
    await transport.post("/api/brain/projects/p/jobs", { kind: "sync" }, { timeoutMs: 15_000 });
    await transport.patch("/api/brain/projects/p/sources/s", { status: "paused" }, { timeoutMs: 15_000 });
    await transport.delete("/api/brain/projects/p/sources/s?expectedRevision=3", { timeoutMs: 15_000 });
    expect(api.get).toHaveBeenCalledWith("/api/brain/projects/p/sources", { timeoutMs: 15_000 });
    expect(api.post).toHaveBeenCalledWith("/api/brain/projects/p/jobs", { kind: "sync" }, { timeoutMs: 15_000 });
    expect(api.patch)
      .toHaveBeenCalledWith("/api/brain/projects/p/sources/s", { status: "paused" }, { timeoutMs: 15_000 });
    expect(api.delete)
      .toHaveBeenCalledWith("/api/brain/projects/p/sources/s?expectedRevision=3", {}, { timeoutMs: 15_000 });
  });

  it("maps the two desktop-only error categories and passes the others through", async () => {
    const failing = (error: unknown) => desktopBrainTransport({
      get: vi.fn(async () => { throw error; }),
    } as unknown as ApiClient).get("/api/workspace/projects");
    const read = (error: unknown) => failing(error).then(() => null, (failure: unknown) => failure);

    const ended = await read(new AppError("fatalSession", { detail: "session_ended" }));
    expect(ended).toMatchObject({ category: "unauthorized", detail: "session_ended" });
    expect(brainShellError(ended)).toEqual({ kind: "unauthorized" });
    expect(brainShellError(await read(new AppError("misconfigured")))).toEqual({ kind: "offline" });
    const notFound = new AppError("notFound", { detail: "project_not_found" });
    expect(await read(notFound)).toBe(notFound);
    expect(brainShellError(notFound)).toEqual({ kind: "not_found", code: "project_not_found" });
    const other = new TypeError("boom");
    expect(await read(other)).toBe(other);
  });
});

describe("DesktopBrainView", () => {
  it("asks to connect when there is no gateway session", () => {
    render(<DesktopBrainView />);
    expect(screen.getByText("Connect to your Matrix computer to open the Company Brain.")).toBeInTheDocument();
  });

  it("lists projects through its pinned runtime and shows the six tabs without an in-app heading", async () => {
    const api = fakeApi();
    useConnection.setState({ status: "signed-in", api: api.root, runtimeSlot: "pr-12", authGeneration: 1 });
    render(<DesktopBrainView />);

    expect(await screen.findByRole("combobox", { name: "Project" })).toHaveValue("proj_matrix_os");
    expect(api.root.forRuntime).toHaveBeenCalledWith("pr-12");
    expect(api.slot("pr-12").get).toHaveBeenCalledWith("/api/workspace/projects", { timeoutMs: 15_000 });
    // Only the chat runs on the shared chat client; the brain routes go through the pinned runtime.
    expect(api.root.get).not.toHaveBeenCalledWith("/api/workspace/projects", expect.anything());
    const tabs = within(screen.getByRole("tablist", { name: "Screens" })).getAllByRole("tab");
    expect(tabs.map((tab) => tab.textContent)).toEqual(["Chat", "Today", "Decisions", "Timeline", "Search", "Sources"]);
    expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
  });

  it("shows a session that ended as no access", async () => {
    const api = fakeApi({ primary: async () => { throw new AppError("fatalSession"); } });
    useConnection.setState({ status: "signed-in", api: api.root, runtimeSlot: "primary", authGeneration: 1 });
    render(<DesktopBrainView />);
    expect(await screen.findByRole("alert")).toHaveTextContent("You do not have access");
  });

  it("remounts on a runtime switch or a new sign-in, so an answer from the old session never lands", async () => {
    const late = deferred<unknown>();
    const api = fakeApi({
      primary: () => late.promise,
      "pr-12": async () => ({ projects: [{ id: "proj_preview", name: "Preview", slug: "preview" }] }),
    });
    useConnection.setState({ status: "signed-in", api: api.root, runtimeSlot: "primary", authGeneration: 1 });
    render(<DesktopBrainView />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading projects...");

    act(() => useConnection.setState({ runtimeSlot: "pr-12" }));
    const picker = await screen.findByRole("combobox", { name: "Project" });
    expect(picker).toHaveValue("proj_preview");
    await act(async () => { late.resolve(PROJECTS); await late.promise; });
    expect(screen.getByRole("combobox", { name: "Project" })).toHaveValue("proj_preview");
    expect(screen.queryByRole("option", { name: "Matrix OS" })).toBeNull();

    // The Chat tab also reads the project's sources on the same runtime; only the project list is counted here.
    const preview = api.slot("pr-12");
    const projectLoads = () => vi.mocked(preview.get).mock.calls.filter(([path]) => path === "/api/workspace/projects").length;
    expect(projectLoads()).toBe(1);
    act(() => useConnection.setState({ authGeneration: 2 }));
    await waitFor(() => expect(projectLoads()).toBe(2));
    expect(await screen.findByRole("combobox", { name: "Project" })).toHaveValue("proj_preview");
  });
});
