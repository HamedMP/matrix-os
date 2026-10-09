// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../../home/apps/utilities/src/App";
import { tools } from "../../home/apps/utilities/src/vendor/lib/catalog.mjs";
import { workspaceKind } from "../../home/apps/utilities/src/utilities-model";

const workspaceFixture = vi.hoisted(() => ({ fail: false }));
vi.mock("../../home/apps/utilities/src/WorkspaceRouter", () => ({
  WorkspaceRouter: ({ tool }: { tool: { title: string } }) => {
    if (workspaceFixture.fail) throw new Error("Workspace fixture failed to open");
    return <>
    <label>Input for {tool.title}<textarea aria-label={`Input for ${tool.title}`}/></label>
    <label>Choose a file<input type="file"/></label>
    <pre>Read-only result</pre>
    <button>Copy</button><button>Download</button><button>Next rows</button>
    <a href="https://matrix-os.com/tools/image-ocr" onClick={(event) => event.preventDefault()}>Open website</a>
    <button data-utilities-dirty="true"><span>Generate result</span></button>
  </>;
  },
}));

beforeEach(() => {
  workspaceFixture.fail = false;
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
});
afterEach(cleanup);

describe("Utilities folder UI", () => {
  it("offers every canonical tool and dispatches every mode", () => {
    render(<App/>);
    expect(tools).toHaveLength(104);
    const cards = new Map(screen.getAllByRole("button").filter((button) => button.querySelector("strong")).map((button) => [button.querySelector("strong")!.textContent, button]));
    const titles = [...cards.keys()];
    for (const tool of tools) {
      expect(titles).toContain(tool.title);
      expect(workspaceKind(tool)).not.toBeNull();
    }
    const artwork = tools.map((tool) => cards.get(tool.title)?.querySelector("img")?.getAttribute("src"));
    expect(artwork.every((src) => src?.startsWith("data:image/svg+xml"))).toBe(true);
    expect(new Set(artwork).size).toBe(tools.length);
  });
  it("filters search/category, announces an empty result and resets", () => {
    render(<App/>);
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "word counter" } });
    expect(screen.getByRole("button", { name: /Word Counter/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /JSON Formatter/ })).toBeNull();
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "nothingmatches1234" } });
    expect(screen.getByRole("heading", { name: "No utilities found" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "No utilities found" }).parentElement?.querySelector("img")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Show all utilities" }));
    fireEvent.click(screen.getByRole("button", { name: "PDF", exact: true }));
    expect(screen.getByRole("button", { name: "PDF", exact: true }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.queryByRole("button", { name: /Word Counter/ })).toBeNull();
  });
  it("keeps unfinished input until discard is confirmed", () => {
    render(<App/>);
    fireEvent.click(screen.getByText("Word Counter", { selector: "strong" }).closest("button")!);
    const input = screen.getByRole("textbox", { name: "Input for Word Counter" });
    fireEvent.change(input, { target: { value: "keep my draft" } });
    fireEvent.click(screen.getByRole("button", { name: "← All utilities" }));
    const dialog = screen.getByRole("dialog", { name: "Leave this workspace?" });
    expect((input as HTMLTextAreaElement).value).toBe("keep my draft");
    fireEvent.click(within(dialog).getByRole("button", { name: "Keep working" }));
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("keep my draft");
    fireEvent.click(screen.getByRole("button", { name: "← All utilities" }));
    fireEvent.click(screen.getByRole("button", { name: "Leave workspace" }));
    expect(screen.getByRole("searchbox")).toBeTruthy();
    fireEvent.click(screen.getByText("Word Counter", { selector: "strong" }).closest("button")!);
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("");
  });
  it("asks before leaving a workspace after dropping a file", () => {
    render(<App/>);
    fireEvent.click(screen.getByText("Image Resizer", { selector: "strong" }).closest("button")!);
    fireEvent.drop(screen.getByRole("textbox"), { dataTransfer: { files: [new File(["image"], "photo.png", { type: "image/png" })] } });
    fireEvent.click(screen.getByRole("button", { name: "← All utilities" }));
    expect(screen.getByRole("dialog", { name: "Leave this workspace?" }).hasAttribute("open")).toBe(true);
  });
  it.each(["Copy", "Download", "Next rows", "Read-only result", "Open website"])("leaves clean workspaces directly after %s", (label) => {
    render(<App/>);
    fireEvent.click(screen.getByText("Word Counter", { selector: "strong" }).closest("button")!);
    fireEvent.click(screen.getByText(label));
    fireEvent.click(screen.getByRole("button", { name: "← All utilities" }));
    expect(screen.queryByRole("dialog", { name: "Leave this workspace?" })).toBeNull();
    expect(screen.getByRole("searchbox")).toBeTruthy();
  });
  it("does not treat a cancelled file picker as an edit", () => {
    render(<App/>);
    fireEvent.click(screen.getByText("Word Counter", { selector: "strong" }).closest("button")!);
    const picker = screen.getByLabelText("Choose a file");
    fireEvent.click(picker);
    fireEvent.change(picker, { target: { files: [] } });
    fireEvent.click(screen.getByRole("button", { name: "← All utilities" }));
    expect(screen.queryByRole("dialog", { name: "Leave this workspace?" })).toBeNull();
    expect(screen.getByRole("searchbox")).toBeTruthy();
  });
  it("protects a selected file and a generated result without requiring a text edit", () => {
    render(<App/>);
    fireEvent.click(screen.getByText("Word Counter", { selector: "strong" }).closest("button")!);
    fireEvent.change(screen.getByLabelText("Choose a file"), { target: { files: [new File(["draft"], "draft.txt")] } });
    fireEvent.click(screen.getByRole("button", { name: "← All utilities" }));
    expect(screen.getByRole("dialog", { name: "Leave this workspace?" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Leave workspace" }));
    fireEvent.click(screen.getByText("Word Counter", { selector: "strong" }).closest("button")!);
    fireEvent.click(screen.getByText("Generate result"));
    fireEvent.click(screen.getByRole("button", { name: "← All utilities" }));
    expect(screen.getByRole("dialog", { name: "Leave this workspace?" })).toBeTruthy();
  });
  it("returns directly from a workspace that failed before creating any work", () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      render(<App/>);
      workspaceFixture.fail = true;
      fireEvent.click(screen.getByText("Word Counter", { selector: "strong" }).closest("button")!);
      expect(screen.getByRole("alert")).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Back to Utilities" }));
      expect(screen.queryByRole("dialog", { name: "Leave this workspace?" })).toBeNull();
      expect(screen.getByRole("searchbox")).toBeTruthy();
    } finally { logged.mockRestore(); }
  });
});
