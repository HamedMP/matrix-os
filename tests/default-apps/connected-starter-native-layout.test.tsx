// @vitest-environment jsdom
import React from "react";
import { readFileSync } from "node:fs";
import { desktopPalette } from "../../packages/brand/src/tokens";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import catalog from "../../home/system/app-gallery.json";
import Sidebar from "../../home/app-templates/connected-starter/src/Sidebar";
import { readRecords } from "../../home/app-templates/connected-starter/src/model";
import WorkspaceContent from "../../home/app-templates/connected-starter/src/WorkspaceContent";
import { ImportDialog } from "../../home/app-templates/connected-starter/src/ImportDialog";
import type { Definition } from "../../home/app-templates/connected-starter/src/types";
const subscriptions = catalog.apps.find(app => app.id === "subscriptions") as Definition;
const email = { id: "email_account", service: "gmail", account_label: "Personal", account_email: "reader@example.test", status: "active" };
afterEach(() => { cleanup(); delete window.MatrixOS; });
describe("compact installed app workflows", () => {
  it("gives expanded controls and records nonshrinking rows in short phone windows", () => {
    const css = readFileSync("home/app-templates/connected-starter/src/styles/gallery-light.css", "utf8");
    const compact = css.split("@media (max-width: 700px) and (max-height: 420px)")[1];
    expect(compact).toMatch(/\.workbench\[data-app\]\s*\{[^}]*grid-template-rows:\s*max-content max-content;[^}]*overflow-y:\s*auto/);
    expect(compact).toMatch(/\.sidebar\s*\{[^}]*max-height:\s*none;[^}]*overflow:\s*visible/);
    expect(compact).toMatch(/main\s*\{[^}]*flex:\s*none;[^}]*overflow:\s*visible/);
    const subjects = readFileSync("home/app-templates/connected-starter/src/styles/subject-views.css", "utf8");
    expect(subjects).toMatch(/\.revenue-overview \.balance p[^}]*\{\s*color:\s*var\(--muted\)/);
  });
  it("ships the shared Matrix palette and local fonts inside the installable template", () => {
    const css = readFileSync("home/app-templates/connected-starter/src/styles/brand-tokens.css", "utf8");
    for (const [key, value] of Object.entries(desktopPalette)) expect(css).toContain(`--matrix-brand-${key}: ${value}`);
    for (const name of ["geist-latin-wght-normal.woff2", "bricolage-grotesque-latin-wght-normal.woff2", "geist-OFL.txt", "bricolage-OFL.txt"]) {
      expect(readFileSync(`home/app-templates/connected-starter/public/fonts/${name}`)).toEqual(readFileSync(`home/apps/_shared/fonts/${name}`));
    }
  });
  it("opens an empty subscriptions workspace with a practical heading and working import/manual actions", () => {
    const onImport = vi.fn(), onAdd = vi.fn();
    render(<WorkspaceContent app={subscriptions} records={[]} visible={[]} error="" exportError="" loading={false} limited={false} unavailable="" canUseRecords onEdit={vi.fn()} onEvidence={vi.fn()} onSave={vi.fn()} onAdd={onAdd} onImport={onImport} canImport />);
    expect(screen.getByRole("heading", { name: "All subscriptions", level: 1 })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "No subscriptions yet" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Find subscriptions in email" }));
    fireEvent.click(screen.getByRole("button", { name: "Add one manually" }));
    expect(onImport).toHaveBeenCalledOnce();
    expect(onAdd).toHaveBeenCalledOnce();
    expect(screen.queryByText("Everything in view")).toBeNull();
  });
  it("offers email accounts without irrelevant source context and preserves the exact selected identity", async () => {
    const generate = vi.fn();
    window.MatrixOS = { integrations: async () => [email], generate };
    render(<ImportDialog app={subscriptions} onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole("checkbox", { name: /reader@example.test/ }));
    expect(screen.queryByRole("textbox")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Ask Matrix to import" }));
    expect(generate).toHaveBeenCalledWith(expect.stringContaining('"connectionId":"email_account"'));
    expect(generate).toHaveBeenCalledWith(expect.stringContaining('"sourceContext":""'));
  });
  it("asks for repository scope only after GitHub is selected and validates it before dispatch", async () => {
    const github = { id: "github_account", service: "github", account_label: "Work", status: "active" };
    const app: Definition = { ...subscriptions, services: [{ id: "github", name: "GitHub", actions: ["list_repositories"] }] };
    const generate = vi.fn();
    window.MatrixOS = { integrations: async () => [github], generate };
    render(<ImportDialog app={app} onClose={vi.fn()} />);
    const checkbox = await screen.findByRole("checkbox");
    expect(screen.queryByRole("textbox")).toBeNull();
    fireEvent.click(checkbox);
    const repository = screen.getByRole("textbox", { name: "Repository" });
    fireEvent.click(screen.getByRole("button", { name: "Ask Matrix to import" }));
    expect(generate).not.toHaveBeenCalled();
    fireEvent.change(repository, { target: { value: "matrix-os/core" } });
    fireEvent.click(screen.getByRole("button", { name: "Ask Matrix to import" }));
    expect(generate).toHaveBeenCalledWith(expect.stringContaining('"sourceContext":"matrix-os/core"'));
  });
});

// Panel choices use the same app-scoped database transport as owner records.
const preferenceId = "f954d542-8bfe-4a50-bac8-10ba5fbe9f25";
const panelProps = { app: subscriptions, count: 0, canUseRecords: true, canImport: true, accounts: [], query: "", setQuery: vi.fn(), scope: "all" as const, setScope: vi.fn(), account: "", setAccount: vi.fn(), onImport: vi.fn(), onAdd: vi.fn() };
function preferenceDb() {
  let stored: Record<string, unknown> | null = null;
  const db = {
    find: vi.fn(async () => []),
    findOne: vi.fn(async (_table: string, _id: string) => stored),
    insert: vi.fn(async (_table: string, row: Record<string, unknown>) => { stored = structuredClone(row); return { id: preferenceId }; }),
    compareAndSwap: vi.fn(async (_table: string, _id: string, expected: Record<string, unknown>, row: Record<string, unknown>) => {
      if (JSON.stringify(stored?.payload) !== JSON.stringify(expected)) return { ok: false };
      stored = { ...stored, ...structuredClone(row) }; return { ok: true };
    }), update: vi.fn(),
  };
  return { db, value: () => stored, set: (row: Record<string, unknown>) => { stored = row; } };
}
function togglePanel(open: boolean) {
  const panel = screen.getByText("Filters & connections").closest("details")!;
  panel.open = open; fireEvent(panel, new Event("toggle")); return panel;
}
function panel() { return screen.getByText("Filters & connections").closest("details")!; }
it("restores both open and closed panel choices after reopening the installed app", async () => {
  const store = preferenceDb(); window.MatrixOS = { db: store.db };
  let view = render(<Sidebar {...panelProps} />);
  expect(panel().open).toBe(false); togglePanel(true);
  await waitFor(() => expect(store.value()?.payload).toMatchObject({ controlsOpen: true }));
  view.unmount(); view = render(<Sidebar {...panelProps} />);
  await waitFor(() => expect(panel().open).toBe(true)); togglePanel(false);
  await waitFor(() => expect(store.value()?.payload).toMatchObject({ controlsOpen: false }));
  view.unmount(); store.db.findOne.mockClear(); render(<Sidebar {...panelProps} />);
  await waitFor(() => expect(store.db.findOne).toHaveBeenCalledOnce());
  expect(panel().open).toBe(false);
});
it("keeps the compact first-use default and isolates choices through each app's host database", async () => {
  const first = preferenceDb(), second = preferenceDb(); window.MatrixOS = { db: first.db };
  const view = render(<Sidebar {...panelProps} />); togglePanel(true);
  await waitFor(() => expect(first.value()).not.toBeNull());
  window.MatrixOS = { db: second.db };
  view.rerender(<Sidebar {...panelProps} app={{ ...subscriptions, id: "people", name: "People" }} />);
  await waitFor(() => expect(second.db.findOne).toHaveBeenCalled());
  expect(panel().open).toBe(false); expect(second.value()).toBeNull();
  expect(first.value()?.payload).toMatchObject({ controlsOpen: true });
});
it("does not replace an owner toggle with a late preference read", async () => {
  const store = preferenceDb(); let resolveRead!: (value: Record<string, unknown>) => void;
  store.db.findOne.mockImplementationOnce(() => new Promise(resolve => { resolveRead = resolve; }));
  window.MatrixOS = { db: store.db }; render(<Sidebar {...panelProps} />); togglePanel(true);
  await waitFor(() => expect(store.value()?.payload).toMatchObject({ controlsOpen: true }));
  await act(async () => resolveRead({ id: preferenceId, payload: { kind: "matrix:panel:v1", controlsOpen: false } }));
  expect(panel().open).toBe(true);
});
it("coalesces rapid toggles while a save is pending and preserves the final choice", async () => {
  const store = preferenceDb(); let finish!: () => void;
  store.db.insert.mockImplementationOnce(async (_table, row) => { await new Promise<void>(resolve => { finish = resolve; }); store.set(structuredClone(row)); return { id: preferenceId }; });
  window.MatrixOS = { db: store.db }; render(<Sidebar {...panelProps} />); togglePanel(true);
  await waitFor(() => expect(store.db.insert).toHaveBeenCalledOnce());
  togglePanel(false); togglePanel(true); togglePanel(false);
  await act(async () => finish());
  await waitFor(() => expect(store.value()?.payload).toMatchObject({ controlsOpen: false }));
  expect(store.db.insert).toHaveBeenCalledOnce(); expect(store.db.compareAndSwap).toHaveBeenCalledOnce();
});
it("keeps the selected panel visible on save failure and retries without logging owner bytes", async () => {
  const store = preferenceDb(); store.db.insert.mockRejectedValueOnce(new Error("owner-secret /private/path"));
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    window.MatrixOS = { db: store.db }; render(<Sidebar {...panelProps} />); togglePanel(true);
    const retry = await screen.findByRole("button", { name: "Retry saving panel choice" });
    expect(panel().open).toBe(true); expect(JSON.stringify(warn.mock.calls)).not.toContain("owner-secret");
    fireEvent.click(retry); await waitFor(() => expect(store.value()?.payload).toMatchObject({ controlsOpen: true }));
    expect(screen.queryByRole("button", { name: "Retry saving panel choice" })).toBeNull();
  } finally { warn.mockRestore(); }
});
it("never replaces an owner record occupying the preference identity", async () => {
  const store = preferenceDb(); const owner = { id: preferenceId, payload: { id: "owner", fields: { title: "Keep me" } } }; store.set(owner);
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    window.MatrixOS = { db: store.db }; render(<Sidebar {...panelProps} />); togglePanel(true);
    await screen.findByRole("button", { name: "Retry saving panel choice" });
    expect(store.value()).toEqual(owner); expect(store.db.compareAndSwap).not.toHaveBeenCalled(); expect(store.db.update).not.toHaveBeenCalled();
  } finally { warn.mockRestore(); }
});
it("keeps preference metadata out of records and exports", () => {
  expect(readRecords([{ id: preferenceId, payload: { kind: "matrix:panel:v1", controlsOpen: true } }])).toEqual([]);
});
it("catches synchronous host read failures without crashing the app", async () => {
  const store = preferenceDb(); store.db.findOne.mockImplementationOnce(() => { throw new Error("owner-secret"); });
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    window.MatrixOS = { db: store.db }; render(<Sidebar {...panelProps} />);
    await screen.findByRole("button", { name: "Retry saving panel choice" });
    expect(panel().open).toBe(false); expect(JSON.stringify(warn.mock.calls)).not.toContain("owner-secret");
  } finally { warn.mockRestore(); }
});
it("retries a concurrent preference change through exact comparison while preserving other metadata", async () => {
  const store = preferenceDb(); store.set({ id: preferenceId, payload: { kind: "matrix:panel:v1", controlsOpen: false, ownerOption: "keep" } });
  store.db.compareAndSwap.mockImplementationOnce(async () => { store.set({ id: preferenceId, payload: { kind: "matrix:panel:v1", controlsOpen: false, ownerOption: "new" } }); return { ok: false }; });
  window.MatrixOS = { db: store.db }; render(<Sidebar {...panelProps} />); togglePanel(true);
  await waitFor(() => expect(store.value()?.payload).toEqual({ kind: "matrix:panel:v1", controlsOpen: true, ownerOption: "new" }));
  expect(store.db.compareAndSwap).toHaveBeenCalledTimes(2);
});
it("recovers concurrent preference creation without a second insert or an unconditional update", async () => {
  const store = preferenceDb(); store.db.insert.mockImplementationOnce(async () => { store.set({ id: preferenceId, payload: { kind: "matrix:panel:v1", controlsOpen: false, ownerOption: "keep" } }); throw new Error("duplicate"); });
  window.MatrixOS = { db: store.db }; render(<Sidebar {...panelProps} />); togglePanel(true);
  await waitFor(() => expect(store.value()?.payload).toEqual({ kind: "matrix:panel:v1", controlsOpen: true, ownerOption: "keep" }));
  expect(store.db.insert).toHaveBeenCalledOnce(); expect(store.db.update).not.toHaveBeenCalled();
});
it("ignores the previous app's late preference after switching app context", async () => {
  const first = preferenceDb(), next = preferenceDb(); let resolveRead!: (value: Record<string, unknown>) => void;
  first.db.findOne.mockImplementationOnce(() => new Promise(resolve => { resolveRead = resolve; }));
  window.MatrixOS = { db: first.db }; const view = render(<Sidebar {...panelProps} />);
  window.MatrixOS = { db: next.db }; view.rerender(<Sidebar {...panelProps} app={{ ...subscriptions, id: "people" }} />);
  await waitFor(() => expect(next.db.findOne).toHaveBeenCalledOnce());
  await act(async () => resolveRead({ id: preferenceId, payload: { kind: "matrix:panel:v1", controlsOpen: true } }));
  expect(panel().open).toBe(false); expect(next.db.insert).not.toHaveBeenCalled();
});
