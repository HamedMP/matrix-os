// @vitest-environment jsdom
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { BotInteraction } from "@matrix-os/contracts";
import { InteractionCard } from "../../../packages/ui/src/chat-agents/bots/InteractionCard.js";

afterEach(cleanup);
const base: BotInteraction = {
  interactionId: "in_abcdefgh", chatId: "chat_research", agentId: "bot_research1", taskId: "task_abcdefgh",
  kind: "question", blocking: true, status: "pending", expiresAt: "2099-01-01T00:00:00.000Z", revision: 1,
  payload: { kind: "question", questions: [{ questionId: "target", header: "Target", question: "Which company?", allowOther: true, secret: false }] },
};

describe("bot interaction cards", () => {
  it("submits a question answer with its revision and waits for the server", async () => {
    const resolve = vi.fn(async () => undefined);
    render(<InteractionCard interaction={base} onResolve={resolve} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Answer Target" }), { target: { value: "Acme" } });
    fireEvent.click(screen.getByRole("button", { name: "Answer" }));
    await waitFor(() => expect(resolve).toHaveBeenCalledWith({ kind: "question", baseRevision: 1,
      structuredAnswers: { target: ["Acme"] } }));
  });

  it("sends each answer with its question ID and supports selected options", async () => {
    const resolve = vi.fn(async () => undefined);
    const card: BotInteraction = { ...base, payload: { kind: "question", questions: [
      { questionId: "target", header: "Target", question: "Which company?", allowOther: true, secret: false },
      { questionId: "format", header: "Format", question: "Which format?", allowOther: false, secret: false,
        options: [{ label: "Brief", description: "One page" }, { label: "Full", description: "Detailed" }] },
    ] } };
    render(<InteractionCard interaction={card} onResolve={resolve} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Answer Target" }), { target: { value: "Acme" } });
    fireEvent.click(screen.getByRole("radio", { name: "Brief" }));
    fireEvent.click(screen.getByRole("button", { name: "Answer" }));
    await waitFor(() => expect(resolve).toHaveBeenCalledWith({ kind: "question", baseRevision: 1,
      structuredAnswers: { target: ["Acme"], format: ["Brief"] } }));
  });

  it("disables answers beyond the structured UTF-8 byte limit", () => {
    render(<InteractionCard interaction={base} onResolve={vi.fn()} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Answer Target" }), { target: { value: "💬".repeat(200) } });
    expect((screen.getByRole("button", { name: "Answer" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByRole("textbox", { name: "Answer Target" }), { target: { value: "💬".repeat(170) } });
    expect((screen.getByRole("button", { name: "Answer" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("clears a selected single choice when Other text becomes the answer", async () => {
    const resolve = vi.fn(async () => undefined);
    const card: BotInteraction = { ...base, payload: { kind: "question", questions: [
      { questionId: "target", header: "Target", question: "Which company?", allowOther: true, secret: false,
        options: [{ label: "Acme", description: "Existing choice" }] },
    ] } };
    render(<InteractionCard interaction={card} onResolve={resolve} />);
    const choice = screen.getByRole("radio", { name: "Acme" }) as HTMLInputElement;
    fireEvent.click(choice);
    expect(choice.checked).toBe(true);
    fireEvent.change(screen.getByRole("textbox", { name: "Answer Target" }), { target: { value: "Globex" } });
    expect(choice.checked).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Answer" }));
    await waitFor(() => expect(resolve).toHaveBeenCalledWith({ kind: "question", baseRevision: 1,
      structuredAnswers: { target: ["Globex"] } }));
  });

  it("shows account choices and never exposes the connection id", async () => {
    const resolve = vi.fn(async () => undefined);
    const card: BotInteraction = { ...base, kind: "account_choice", payload: { kind: "account_choice", service: "gmail",
      options: [{ connectionId: "conn_private", label: "Work" }, { connectionId: "conn_other", label: "Personal" }] } };
    render(<InteractionCard interaction={card} onResolve={resolve} />);
    expect(screen.queryByText(/conn_private/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Work" }));
    await waitFor(() => expect(resolve).toHaveBeenCalledWith({ kind: "account_choice", baseRevision: 1, connectionId: "conn_private" }));
  });

  it("requires an explicit approval decision and keeps unsafe failures private", async () => {
    const resolve = vi.fn(async () => { throw new Error("provider token at /home/matrix"); });
    const card: BotInteraction = { ...base, kind: "approval", payload: { kind: "approval", tool: "gmail.send",
      argsDigest: "a".repeat(64), audience: "direct", preview: "Send the brief", policyRevision: 1 } };
    render(<InteractionCard interaction={card} onResolve={resolve} />);
    expect(screen.getByText("Send the brief")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await screen.findByRole("alert");
    expect(screen.getByRole("alert").textContent).not.toMatch(/provider|token|\/home/);
  });

  it("disables expired and resolved requests", () => {
    render(<InteractionCard interaction={{ ...base, status: "resolved" }} onResolve={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Answer" })).toBeNull();
    cleanup();
    render(<InteractionCard interaction={{ ...base, expiresAt: "2000-01-01T00:00:00.000Z" }} onResolve={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Answer" })).toBeNull();
  });

  it("offers the returned HTTPS consent URL as a user-clicked link", async () => {
    const card: BotInteraction = { ...base, kind: "connect_request", payload: { kind: "connect_request",
      service: "gmail", access: ["read"], benefit: "Read your inbox", connectRequestId: "cr_abcdefgh" } };
    render(<InteractionCard interaction={card} onResolve={vi.fn(async () => ({
      interaction: { interactionId: card.interactionId, status: "resolved" as const, revision: 2 },
      connectUrl: "https://consent.example.test/start",
    }))} />);
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    const link = await screen.findByRole("link", { name: "Continue connecting" });
    expect(link.getAttribute("href")).toBe("https://consent.example.test/start");
  });
});
