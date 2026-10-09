// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { marked } from "marked";
import { EditorWorkspace } from "../../home/apps/utilities/src/vendor/workspaces/EditorWorkspace";
import { WorkflowWorkspace } from "../../home/apps/utilities/src/vendor/workspaces/WorkflowWorkspace";

vi.mock("marked", () => ({ marked: { parse: vi.fn() } }));
vi.mock("dompurify", () => ({ default: { sanitize: vi.fn((value: string) => value) } }));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function mockExports() {
  const copied: string[] = [];
  vi.stubGlobal("URL", {
    ...URL,
    createObjectURL: vi.fn(() => "blob:utilities-test"),
    revokeObjectURL: vi.fn(),
  });
  vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText: vi.fn(async (text: string) => { copied.push(text); }) } });
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  return copied;
}

describe("Utilities editor and workflow result lifecycle", () => {
  it("removes text exports immediately when the source changes", () => {
    mockExports();
    render(<EditorWorkspace slug="text-workspace" />);
    fireEvent.click(screen.getByRole("button", { name: "trim" }));
    expect(screen.getByRole("button", { name: "Copy result" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Download result" })).toBeTruthy();

    fireEvent.change(screen.getByRole("textbox", { name: "Your text" }), { target: { value: "new source" } });
    expect(screen.queryByRole("button", { name: "Copy result" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Download result" })).toBeNull();
  });

  it("keeps empty trim output completed and exports the empty value", async () => {
    const copied = mockExports();
    render(<EditorWorkspace slug="text-workspace" />);
    fireEvent.change(screen.getByRole("textbox", { name: "Your text" }), { target: { value: "   \n  " } });
    fireEvent.click(screen.getByRole("button", { name: "trim" }));

    expect(screen.getByText("The result is empty.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Copy result" }));
    await waitFor(() => expect(copied).toEqual([""]));
    fireEvent.click(screen.getByRole("button", { name: "Download result" }));
    expect(HTMLAnchorElement.prototype.click).toHaveBeenCalled();
  });

  it("does not publish an older Markdown render after the source changes", async () => {
    const parses: Array<{ text: string; resolve: (value: string) => void }> = [];
    vi.mocked(marked.parse).mockImplementation((text) => new Promise((resolve) => {
      parses.push({ text: String(text), resolve: (value) => resolve(value as never) });
    }) as never);
    const { container } = render(<EditorWorkspace slug="markdown-editor" />);
    const input = screen.getByRole("textbox", { name: "Markdown source" });

    await waitFor(() => expect(parses).toHaveLength(1), { timeout: 2_000 });
    fireEvent.change(input, { target: { value: "latest source" } });
    await act(async () => { parses[0].resolve("<p>old preview</p>"); await Promise.resolve(); });
    expect(container.querySelector(".prose")?.innerHTML).toBe("");

    await waitFor(() => expect(parses).toHaveLength(2), { timeout: 2_000 });
    await act(async () => { parses[1].resolve("<p>latest preview</p>"); await Promise.resolve(); });
    expect(container.querySelector(".prose")?.innerHTML).toBe("<p>latest preview</p>");
  });

  it("keeps Copy and Download available when the workflow result is empty", async () => {
    const copied = mockExports();
    render(<WorkflowWorkspace />);
    fireEvent.change(screen.getByRole("textbox", { name: "Starting text" }), { target: { value: "!!!" } });
    fireEvent.click(screen.getByRole("button", { name: "Run workflow" }));

    expect(await screen.findByText("The result is empty.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    await waitFor(() => expect(copied).toEqual([""]));
    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    expect(HTMLAnchorElement.prototype.click).toHaveBeenCalled();
  });
});
