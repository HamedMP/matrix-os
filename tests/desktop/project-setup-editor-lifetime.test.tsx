// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  get: vi.fn(), patch: vi.fn(), openTab: vi.fn(), requestSettingsSection: vi.fn(),
  projectId: "project_a",
  connection: { api: null as unknown, runtimeSlot: "preview", authGeneration: 1 },
}));
vi.mock("../../desktop/src/renderer/src/stores/connection", () => ({
  useConnection: Object.assign((select: (state: typeof mocks.connection) => unknown) => select(mocks.connection), { getState: () => mocks.connection }),
}));
vi.mock("../../desktop/src/renderer/src/stores/board", () => ({
  useBoard: (select: (state: unknown) => unknown) => select({ projects: [{ id: "project_a", slug: "alpha", name: "Alpha" }] }),
}));
vi.mock("../../desktop/src/renderer/src/stores/ui", () => ({ useUi: { getState: () => ({ requestSettingsSection: mocks.requestSettingsSection }) } }));
vi.mock("../../desktop/src/renderer/src/stores/tabs", () => ({ useTabs: { getState: () => ({ openTab: mocks.openTab }) } }));
vi.mock("../../desktop/src/renderer/src/features/editor/desktop-editor-store", () => ({ openFileInDesktopEditor: vi.fn() }));

import { useDesktopProjectSetup } from "../../desktop/src/renderer/src/features/project/use-desktop-project-setup";

const api = { baseUrl: "https://preview.invalid", forRuntime: () => api, get: mocks.get, patch: mocks.patch, post: vi.fn() };
const draft = {
  chatId: "chat_setup", projectId: "project_a", revision: 3, step: "review", currentQuestionMessageId: "msg_question",
  answers: { purpose: "Portfolio", guidance: "Run checks" },
  proposals: [{ path: "AGENTS.md", content: "# Original guidance", status: "pending" }],
  mcp: { state: "pending", service: "Linear" }, updatedAt: "2026-11-22T12:00:00Z",
};
function Workspace({ eligible, chatId = "chat_setup", projectId = "project_a" }: { eligible: boolean; chatId?: string; projectId?: string }) {
  const setup = useDesktopProjectSetup({ api: api as never, projectId, chatId, eligible, openChat: vi.fn(), refresh: vi.fn() });
  return <><button onClick={() => void setup.reload()}>Refresh setup</button>{setup.controls}</>;
}
beforeEach(() => {
  mocks.projectId = "project_a";
  mocks.connection = { api, runtimeSlot: "preview", authGeneration: 1 };
  mocks.get.mockImplementation(async (path: string) => path === "/api/mcp-servers" ? [] : { draft: { ...draft, projectId: mocks.projectId, chatId: path.includes("chat_other") ? "chat_other" : "chat_setup" } });
  mocks.patch.mockResolvedValue({ draft });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

async function editGuidance() {
  fireEvent.click(await screen.findByRole("button", { name: "Edit Markdown" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Markdown for AGENTS.md" }), { target: { value: "# My unapplied guidance" } });
}

it("keeps unapplied Markdown through the native Settings unmount and same-scope reload", async () => {
  const view = render(<Workspace eligible />);
  await editGuidance();
  fireEvent.click(screen.getByRole("button", { name: "Open MCP settings" }));
  expect(mocks.openTab).toHaveBeenCalledWith({ kind: "settings", title: "Settings" });
  view.rerender(<Workspace eligible={false} />);
  expect(screen.queryByRole("textbox")).toBeNull();
  expect(mocks.patch).not.toHaveBeenCalled();
  view.rerender(<Workspace eligible />);
  expect(await screen.findByRole("textbox", { name: "Markdown for AGENTS.md" })).toHaveProperty("value", "# My unapplied guidance");
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "Save project setup" }).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Apply draft changes" }));
  await waitFor(() => expect(mocks.patch).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ action: { type: "review_file", path: "AGENTS.md", content: "# My unapplied guidance" } }), expect.anything()));
});

it.each(["chat", "runtime", "account", "project"])("discards transient Markdown when the %s scope changes", async (scope) => {
  const view = render(<Workspace eligible />);
  await editGuidance();
  view.rerender(<Workspace eligible={false} />);
  if (scope === "project") mocks.projectId = "project_b";
  if (scope === "runtime") mocks.connection.runtimeSlot = "different-preview";
  if (scope === "account") mocks.connection.authGeneration += 1;
  view.rerender(<Workspace eligible projectId={mocks.projectId} chatId={scope === "chat" ? "chat_other" : "chat_setup"} />);
  fireEvent.click(await screen.findByRole("button", { name: "Edit Markdown" }));
  expect(screen.getByRole("textbox", { name: "Markdown for AGENTS.md" })).toHaveProperty("value", "# Original guidance");
});

it("keeps the local edit through a failed return read and a later network retry", async () => {
  const view = render(<Workspace eligible />);
  await editGuidance();
  view.rerender(<Workspace eligible={false} />);
  const reads = mocks.get.mock.calls.length;
  fireEvent.click(screen.getByRole("button", { name: "Refresh setup" }));
  expect(mocks.get).toHaveBeenCalledTimes(reads);
  mocks.get.mockRejectedValueOnce(new Error("network unavailable"));
  view.rerender(<Workspace eligible />);
  await waitFor(() => expect(mocks.get).toHaveBeenCalledTimes(reads + 1));
  fireEvent.click(screen.getByRole("button", { name: "Refresh setup" }));
  expect(await screen.findByRole("textbox", { name: "Markdown for AGENTS.md" })).toHaveProperty("value", "# My unapplied guidance");
  expect(mocks.patch).not.toHaveBeenCalled();
});
