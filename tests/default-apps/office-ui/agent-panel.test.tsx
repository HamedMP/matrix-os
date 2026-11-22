// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentPanel, type AgentResult, type AgentStatusLine } from "../../../home/apps/_shared/office-ui";

afterEach(cleanup);

const results: AgentResult[] = [
  { id: "r1", title: "Tighten the indemnity clause", summary: "2 insertions, 1 deletion", status: "proposed" },
  { id: "r2", title: "Rename defined term", status: "accepted" },
  { id: "r3", title: "Shorten the intro", status: "rejected" },
];

const status: AgentStatusLine[] = [
  { id: "s1", text: "Reading section 4", state: "done" },
  { id: "s2", text: "Drafting changes", state: "running" },
];

describe("AgentPanel", () => {
  it("submits a trimmed prompt with Enter, clears the box and ignores blank prompts", () => {
    const onSubmit = vi.fn();
    render(<AgentPanel onSubmit={onSubmit} />);
    const box = screen.getByRole("textbox", { name: "Ask the agent" });
    fireEvent.change(box, { target: { value: "   " } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(onSubmit).not.toHaveBeenCalled();
    fireEvent.change(box, { target: { value: "  Make it shorter " } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledWith("Make it shorter");
    expect((box as HTMLTextAreaElement).value).toBe("");
  });

  it("keeps Shift+Enter as a newline and submits with the send button", () => {
    const onSubmit = vi.fn();
    render(<AgentPanel onSubmit={onSubmit} />);
    const box = screen.getByRole("textbox", { name: "Ask the agent" });
    fireEvent.change(box, { target: { value: "Line one" } });
    fireEvent.keyDown(box, { key: "Enter", shiftKey: true });
    expect(onSubmit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Send to agent" }));
    expect(onSubmit).toHaveBeenCalledWith("Line one");
  });

  it("blocks submit while busy and offers Stop when cancel is supported", () => {
    const onSubmit = vi.fn();
    const onCancel = vi.fn();
    render(<AgentPanel busy onSubmit={onSubmit} onCancel={onCancel} statusLines={status} />);
    const box = screen.getByRole("textbox", { name: "Ask the agent" });
    fireEvent.change(box, { target: { value: "Another" } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(onSubmit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("announces status lines in a live log", () => {
    render(<AgentPanel onSubmit={vi.fn()} statusLines={status} />);
    const log = screen.getByRole("log");
    expect(log.getAttribute("aria-live")).toBe("polite");
    expect(within(log).getByText("Reading section 4")).toBeTruthy();
    expect(within(log).getByText("Drafting changes").closest("[data-state]")?.getAttribute("data-state")).toBe("running");
  });

  it("offers Accept and Reject only on proposed results and reports the result id", () => {
    const onAccept = vi.fn();
    const onReject = vi.fn();
    render(<AgentPanel onSubmit={vi.fn()} results={results} onAccept={onAccept} onReject={onReject} />);
    const proposed = screen.getByRole("article", { name: "Tighten the indemnity clause" });
    fireEvent.click(within(proposed).getByRole("button", { name: "Accept" }));
    fireEvent.click(within(proposed).getByRole("button", { name: "Reject" }));
    expect(onAccept).toHaveBeenCalledWith("r1");
    expect(onReject).toHaveBeenCalledWith("r1");
    const accepted = screen.getByRole("article", { name: "Rename defined term" });
    expect(within(accepted).queryByRole("button", { name: "Accept" })).toBeNull();
    expect(within(accepted).getByText("Accepted")).toBeTruthy();
    expect(within(screen.getByRole("article", { name: "Shorten the intro" })).getByText("Rejected")).toBeTruthy();
  });

  it("renders the conversation and suggestions that fill the prompt", () => {
    const onSubmit = vi.fn();
    render(
      <AgentPanel
        onSubmit={onSubmit}
        messages={[{ id: "u1", role: "user", text: "Summarise" }, { id: "a1", role: "agent", text: "Here is a summary" }]}
        suggestions={["Fix typos"]}
      />,
    );
    expect(screen.getByText("Summarise")).toBeTruthy();
    expect(screen.getByText("Here is a summary")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Fix typos" }));
    expect(onSubmit).toHaveBeenCalledWith("Fix typos");
  });
});
