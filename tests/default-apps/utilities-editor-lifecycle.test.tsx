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


function delayedCsvFile() {
  let resolve!: (value: string) => void, reject!: (cause: Error) => void;
  const read = new Promise<string>((yes, no) => { resolve = yes; reject = no; });
  const file = new File(["fixture"], "fixture.csv", { type: "text/csv" });
  Object.defineProperty(file, "text", { value: () => read });
  return { file, resolve, reject };
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
  it("disables table and PDF actions until a CSV file finishes reading", async () => {
    mockExports();
    const { container } = render(<EditorWorkspace slug="csv-editor" />);
    const csv = delayedCsvFile();
    const open = screen.getByRole("button", { name: "Open table" }) as HTMLButtonElement;
    const pdf = screen.getByRole("button", { name: "Download PDF" }) as HTMLButtonElement;
    fireEvent.change(container.querySelector('input[type="file"]')!, { target: { files: [csv.file] } });
    expect(open.disabled).toBe(true); expect(pdf.disabled).toBe(true);
    expect(screen.getByRole("button", { name: "Loading CSV…" })).toBeTruthy();
    fireEvent.click(open); fireEvent.click(pdf);
    expect(HTMLAnchorElement.prototype.click).not.toHaveBeenCalled();
    await act(async () => { csv.resolve("Header,Value\nCurrent,Table"); await Promise.resolve(); });
    expect(open.disabled).toBe(false); expect(pdf.disabled).toBe(false);
    expect((screen.getByRole("textbox", { name: "Row 2 column 1" }) as HTMLInputElement).value).toBe("Current");
  });

  it("releases CSV loading after read failure and preserves the edited table", async () => {
    mockExports();
    const { container } = render(<EditorWorkspace slug="csv-editor" />);
    fireEvent.change(screen.getByRole("textbox", { name: "Row 2 column 1" }), { target: { value: "kept edit" } });
    const csv = delayedCsvFile();
    fireEvent.change(container.querySelector('input[type="file"]')!, { target: { files: [csv.file] } });
    expect((screen.getByRole("button", { name: "Open table" }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => { csv.reject(new Error("private /home/person/input.csv")); await Promise.resolve(); });
    expect(screen.getByRole("alert").textContent).toBe("Could not open this CSV file.");
    expect((screen.getByRole("textbox", { name: "Row 2 column 1" }) as HTMLInputElement).value).toBe("kept edit");
    expect((screen.getByRole("button", { name: "Download PDF" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("ignores a late CSV file read after editing the source", async () => {
    mockExports();
    const { container } = render(<EditorWorkspace slug="csv-editor" />);
    const csv = delayedCsvFile();
    fireEvent.change(container.querySelector('input[type="file"]')!, { target: { files: [csv.file] } });
    const input = screen.getByRole("textbox", { name: "CSV source" }) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "Latest,Source" } });
    await act(async () => { csv.resolve("Old,Table\nStale,Value"); await Promise.resolve(); });
    expect(input.value).toBe("Latest,Source");
    expect(screen.queryByRole("textbox", { name: "Row 2 column 1" })).toBeNull();
    expect((screen.getByRole("button", { name: "Open table" }) as HTMLButtonElement).disabled).toBe(false);
  });

});
