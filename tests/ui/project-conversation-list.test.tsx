// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectConversationList } from "../../packages/ui/src/chat/ProjectConversationList";
import type { ChatNavigationRecord } from "../../packages/ui/src/chat-navigation/projection";
import { chatRecord } from "./project-conversation-fixtures";

const NOW = Date.parse("2026-11-10T10:05:00.000Z");
afterEach(() => cleanup());

const rowNames = () => within(screen.getByRole("list", { name: "Matrix OS chats" })).getAllByRole("button").map((button) => button.getAttribute("aria-label"));

describe("ProjectConversationList", () => {
  it("renders one row per Chat with live status, agent and time, and opens the exact Chat", () => {
    const onSelect = vi.fn();
    const running = chatRecord("chat_running", { chat: { title: "Fix composer" }, activeRun: { runId: "run_1", turnId: "turn_1", status: "running" } as NonNullable<ChatNavigationRecord["activeRun"]>, driverKind: "codex" });
    render(<ProjectConversationList projectName="Matrix OS" status="ready" nowMs={NOW} onSelect={onSelect}
      records={[running, chatRecord("chat_done", { chat: { title: "Write notes" } })]} />);
    const row = screen.getByRole("button", { name: "Open Fix composer, Running" });
    expect(row).toHaveTextContent("Codex · 5m");
    expect(screen.getByRole("button", { name: "Open Write notes, Done" })).toBeInTheDocument();
    fireEvent.click(row);
    expect(onSelect).toHaveBeenCalledWith(running);
  });

  it("filters by status and search, and offers a way back from no matches", () => {
    render(<ProjectConversationList projectName="Matrix OS" status="ready" nowMs={NOW} onSelect={() => undefined} records={[
      chatRecord("a", { chat: { title: "Approve deploy", attention: "approval_required" } }),
      chatRecord("b", { chat: { title: "Release notes" } }),
    ]} />);
    fireEvent.click(screen.getByRole("button", { name: /^Needs you/ }));
    expect(rowNames()).toEqual(["Open Approve deploy, Approval"]);
    fireEvent.change(screen.getByRole("searchbox", { name: "Search chats by title" }), { target: { value: "release" } });
    expect(screen.getByText("No chats match your search.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(rowNames()).toHaveLength(2);
  });

  it("renders a bounded page and reveals more on request", () => {
    const records = Array.from({ length: 120 }, (_, index) => chatRecord(`chat_${String(index).padStart(3, "0")}`));
    render(<ProjectConversationList projectName="Matrix OS" status="ready" nowMs={NOW} onSelect={() => undefined} records={records} />);
    expect(rowNames()).toHaveLength(50);
    fireEvent.click(screen.getByRole("button", { name: "Show more (70)" }));
    expect(rowNames()).toHaveLength(100);
  });

  it("distinguishes loading, error and empty states", () => {
    const onRetry = vi.fn();
    const { rerender } = render(<ProjectConversationList projectName="Matrix OS" status="loading" nowMs={NOW} records={[]} />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading chats");
    rerender(<ProjectConversationList projectName="Matrix OS" status="error" nowMs={NOW} records={[]} onRetry={onRetry} />);
    fireEvent.click(within(screen.getByRole("alert")).getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalled();
    rerender(<ProjectConversationList projectName="Matrix OS" status="ready" nowMs={NOW} records={[]} />);
    expect(screen.getByText("No chats in Matrix OS yet")).toBeInTheDocument();
  });

  it("gives the empty project and no-match states an icon, an explanation and a way forward", () => {
    const { rerender } = render(<ProjectConversationList projectName="Matrix OS" status="ready" nowMs={NOW} records={[]} />);
    const empty = screen.getByTestId("project-conversations-empty");
    expect(empty.querySelector("svg")).not.toBeNull();
    expect(empty).toHaveTextContent("No chats in Matrix OS yet");
    expect(empty).toHaveTextContent("Every conversation in this project shows up here.");
    expect(empty).toHaveTextContent("Start one from the composer below.");

    rerender(<ProjectConversationList projectName="Matrix OS" status="ready" nowMs={NOW} onSelect={() => undefined}
      records={[chatRecord("b", { chat: { title: "Release notes" } })]} />);
    fireEvent.change(screen.getByRole("searchbox", { name: "Search chats by title" }), { target: { value: "missing" } });
    const noMatch = screen.getByTestId("project-conversations-empty");
    expect(noMatch.querySelector("svg")).not.toBeNull();
    expect(noMatch).toHaveTextContent("No chats match your search.");
    expect(noMatch).toHaveTextContent("Try another title or clear the filters.");
    expect(within(noMatch).getByRole("button", { name: "Clear filters" })).toBeInTheDocument();
  });
});
