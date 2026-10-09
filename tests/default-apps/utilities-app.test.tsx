// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../../home/apps/utilities/src/App";
import { tools } from "../../home/apps/utilities/src/vendor/lib/catalog.mjs";
import { workspaceKind } from "../../home/apps/utilities/src/utilities-model";

vi.mock("../../home/apps/utilities/src/WorkspaceRouter", () => ({
  WorkspaceRouter: ({ tool }: { tool: { title: string } }) => <label>Input for {tool.title}<textarea aria-label={`Input for ${tool.title}`}/></label>,
}));

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
});
afterEach(cleanup);

describe("Utilities folder UI", () => {
  it("offers every canonical tool and dispatches every mode", () => {
    render(<App/>);
    expect(tools).toHaveLength(104);
    const titles = screen.getAllByRole("button").map((button) => button.querySelector("strong")?.textContent).filter(Boolean);
    for (const tool of tools) {
      expect(titles).toContain(tool.title);
      expect(workspaceKind(tool)).not.toBeNull();
    }
    const artwork = tools.map((tool) => screen.getByRole("button", { name: new RegExp(tool.title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) }).querySelector("img")?.getAttribute("src"));
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
    fireEvent.click(screen.getByRole("button", { name: /Word Counter/ }));
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
    fireEvent.click(screen.getByRole("button", { name: /Word Counter/ }));
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("");
  });
  it("asks before leaving a workspace after dropping a file", () => {
    render(<App/>);
    fireEvent.click(screen.getByRole("button", { name: /Image Resizer/ }));
    fireEvent.drop(screen.getByRole("textbox"), { dataTransfer: { files: [new File(["image"], "photo.png", { type: "image/png" })] } });
    fireEvent.click(screen.getByRole("button", { name: "← All utilities" }));
    expect(screen.getByRole("dialog", { name: "Leave this workspace?" }).hasAttribute("open")).toBe(true);
  });
});
