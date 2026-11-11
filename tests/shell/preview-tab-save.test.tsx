// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { PreviewTabContent } from "../../shell/src/components/preview-window/PreviewTab";
import { PreviewWindow } from "../../shell/src/components/preview-window/PreviewWindow";
import { usePreviewWindow, type PreviewTab } from "../../shell/src/hooks/usePreviewWindow";

vi.mock("../../shell/src/components/preview-window/CodeEditor", () => ({
  CodeEditor: ({ content, filename, onChange }: {
    content: string; filename: string; onChange(value: string): void;
  }) => <textarea aria-label={filename} value={content} onChange={e => onChange(e.target.value)} />,
}));

vi.mock("@clerk/nextjs", () => ({
  useAuth: () => ({ userId: "owner", sessionId: "session" }),
}));

const config: PreviewTab = { id: "config", path: "projects/example/.mcp.json", name: ".mcp.json", type: "code" };

afterEach(() => {
  cleanup();
  usePreviewWindow.setState(usePreviewWindow.getInitialState());
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("disables editing on a failed read and distinguishes an empty successful retry", async () => {
  const fetch = vi.fn().mockResolvedValueOnce(new Response("private detail", { status: 403 }))
    .mockResolvedValueOnce(new Response(""));
  vi.stubGlobal("fetch", fetch);
  render(<PreviewTabContent tab={config} />);

  expect(await screen.findByRole("alert")).toHaveTextContent("Could not open this file.");
  expect(screen.queryByText("private detail")).toBeNull();
  expect(screen.queryByRole("textbox")).toBeNull();
  expect(screen.queryByRole("button", { name: "Save" })).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(await screen.findByRole("textbox")).toHaveValue("");
  expect(fetch).toHaveBeenCalledTimes(2);
});

it("keeps the draft after a failed save and can retry successfully", async () => {
  const fetch = vi.fn().mockResolvedValueOnce(new Response("original"))
    .mockResolvedValueOnce(new Response("private detail", { status: 500 }))
    .mockResolvedValueOnce(Response.json({ ok: true }));
  vi.stubGlobal("fetch", fetch);
  render(<PreviewTabContent tab={config} />);
  const editor = await screen.findByRole("textbox");

  fireEvent.change(editor, { target: { value: "revised" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Could not save this file.");
  expect(editor).toHaveValue("revised");
  expect(usePreviewWindow.getState().unsavedTabs.has(config.id)).toBe(true);

  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(usePreviewWindow.getState().unsavedTabs.has(config.id)).toBe(false));
  expect(fetch).toHaveBeenLastCalledWith(expect.stringContaining("projects%2Fexample%2F.mcp.json&force=true"),
    expect.objectContaining({ method: "PUT", body: "revised" }));
  expect(screen.queryByRole("alert")).toBeNull();
});

it("does not clear the unsaved indicator for edits made while a save is pending", async () => {
  let resolveSave!: (response: Response) => void;
  const fetch = vi.fn().mockResolvedValueOnce(new Response("original"))
    .mockReturnValueOnce(new Promise<Response>(resolve => { resolveSave = resolve; }));
  vi.stubGlobal("fetch", fetch);
  render(<PreviewTabContent tab={config} />);
  const editor = await screen.findByRole("textbox");

  fireEvent.change(editor, { target: { value: "first draft" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  fireEvent.change(editor, { target: { value: "newer draft" } });
  await act(async () => { resolveSave(Response.json({ ok: true })); });

  expect(editor).toHaveValue("newer draft");
  expect(usePreviewWindow.getState().unsavedTabs.has(config.id)).toBe(true);
  expect(fetch).toHaveBeenLastCalledWith(expect.any(String),
    expect.objectContaining({ method: "PUT", body: "first draft" }));
});

it("keeps an unsaved project config draft when switching preview tabs", async () => {
  const read = vi.fn(async (url: string) => new Response(url.includes(".mcp.json") ? "original" : "instructions"));
  vi.stubGlobal("fetch", read);
  const instructions: PreviewTab = { id: "instructions", path: "projects/example/AGENTS.md", name: "AGENTS.md", type: "markdown", mode: "source" };
  usePreviewWindow.setState({ tabs: [config, instructions], activeTabId: config.id });
  render(<PreviewWindow />);

  fireEvent.change(await screen.findByRole("textbox", { name: ".mcp.json" }), { target: { value: "unsaved draft" } });
  fireEvent.click(screen.getByRole("tab", { name: "AGENTS.md" }));
  expect(await screen.findByRole("textbox", { name: "AGENTS.md" })).toHaveValue("instructions");
  expect(screen.queryByRole("textbox", { name: ".mcp.json" })).toBeNull();

  fireEvent.click(screen.getByRole("tab", { name: ".mcp.json" }));
  expect(screen.getByRole("textbox", { name: ".mcp.json" })).toHaveValue("unsaved draft");
  expect(read).toHaveBeenCalledTimes(2);
});

it("keeps all edited files accessible at the draft limit and allows media previews", async () => {
  const fetch = vi.fn(async (_url: string, init?: RequestInit) =>
    init?.method === "PUT" ? Response.json({ ok: true }) : new Response("original"),
  );
  vi.stubGlobal("fetch", fetch);
  const configs = Array.from({ length: 4 }, (_, index): PreviewTab => ({
    ...config, id: String(index), name: `config-${index}.toml`, path: `projects/example/config-${index}.toml`,
  }));
  const media: PreviewTab = { id: "pdf", path: "projects/example/manual.pdf", name: "manual.pdf", type: "pdf" };
  usePreviewWindow.setState({ tabs: [...configs, media], activeTabId: configs[0].id });
  render(<PreviewWindow />);

  for (const tab of configs.slice(0, 3)) {
    fireEvent.click(screen.getByRole("tab", { name: tab.name }));
    fireEvent.change(await screen.findByRole("textbox", { name: tab.name }), { target: { value: `draft ${tab.id}` } });
  }

  fireEvent.click(screen.getByRole("tab", { name: media.name }));
  expect(screen.getByRole("link", { name: "Open in browser" })).toBeVisible();
  fireEvent.click(screen.getByRole("tab", { name: configs[3].name }));
  expect(screen.getByRole("status")).toHaveTextContent("Save or close an edited file to open another editor.");
  expect(screen.queryByRole("textbox")).toBeNull();
  expect(fetch).toHaveBeenCalledTimes(3);

  fireEvent.click(screen.getByRole("tab", { name: configs[0].name }));
  expect(screen.getByRole("textbox", { name: configs[0].name })).toHaveValue("draft 0");
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(usePreviewWindow.getState().unsavedTabs.size).toBe(2));
  fireEvent.click(screen.getByRole("tab", { name: configs[3].name }));
  expect(await screen.findByRole("textbox", { name: configs[3].name })).toHaveValue("original");
});

it("does not treat stale dirty flags as drafts when the editor remounts", async () => {
  const fetch = vi.fn(async () => new Response("current file"));
  vi.stubGlobal("fetch", fetch);
  const staleTabs = Array.from({ length: 3 }, (_, index): PreviewTab => ({
    ...config, id: `stale-${index}`, path: `projects/example/config-${index}.toml`,
  }));
  usePreviewWindow.setState({
    tabs: [...staleTabs, config],
    activeTabId: config.id,
    unsavedTabs: new Set([...staleTabs.map(tab => tab.id), config.id]),
  });
  render(<PreviewWindow />);

  expect(await screen.findByRole("textbox", { name: config.name })).toHaveValue("current file");
  expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  expect(fetch).toHaveBeenCalledTimes(1);
});
