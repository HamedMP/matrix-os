import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { BotChatControls } from "@/components/BotChatControls";

jest.mock("micromark", () => ({ micromark: jest.fn() }));
jest.mock("micromark-extension-gfm", () => ({ gfm: jest.fn(), gfmHtml: jest.fn() }));

const snapshot = {
  agentId: "bot_research1", name: "Research Rabbit",
  interactions: [{ interactionId: "in_abcdefgh", chatId: "chat_research", agentId: "bot_research1",
    taskId: "task_abcdefgh", kind: "question", blocking: true, status: "pending",
    expiresAt: "2099-01-01T00:00:00.000Z", revision: 1,
    payload: { kind: "question", questions: [
      { questionId: "target", header: "Target", question: "Which company?", allowOther: true, secret: false },
      { questionId: "format", header: "Format", question: "Which format?", allowOther: false, secret: false,
        options: [{ label: "Brief", description: "One page" }] },
    ] } }],
  tasks: [{ taskId: "task_abcdefgh", chatId: "chat_research", agentId: "bot_research1",
    status: "waiting_person", revision: 1, updatedAt: "2026-09-28T12:00:00.000Z" }],
  authority: { agentId: "bot_research1", revision: 1,
    grants: [{ grantId: "gr_abcdefgh", service: "gmail", accountLabel: "Work", effects: ["read"], audience: "direct", expiresAt: null }],
    connections: [{ service: "gmail", state: "granted" }], routines: [], pendingInteractions: [],
    memory: { items: [{ itemId: "mem_abcdefgh", kind: "preference", scope: "bot", content: "Keep briefs concise",
      source: { at: "2026-09-28T12:00:00.000Z" }, confirmed: false, revision: 1 }] } },
};

it("shows Native Mobile bot identity, question mapping, task status, and authority", async () => {
  const onResolve = jest.fn(async () => ({ interaction: { interactionId: "in_abcdefgh", status: "resolved", revision: 2 } }));
  const onRevoke = jest.fn(async () => undefined);
  const onMemory = jest.fn(async () => undefined);
  render(<BotChatControls snapshot={snapshot as never} onResolve={onResolve as never} onRevoke={onRevoke}
    onMemory={onMemory} onRefresh={jest.fn()} />);
  expect(screen.getByText("Research Rabbit")).toBeTruthy();
  expect(screen.getByText("Waiting for your answer")).toBeTruthy();
  fireEvent.changeText(screen.getByLabelText("Answer Target"), "Acme");
  fireEvent.press(screen.getByText("Brief"));
  fireEvent.press(screen.getByText("Answer"));
  await waitFor(() => expect(onResolve).toHaveBeenCalledWith("in_abcdefgh", {
    kind: "question", baseRevision: 1, structuredAnswers: { target: ["Acme"], format: ["Brief"] },
  }));
  fireEvent.press(screen.getByText("Access & memory"));
  expect(screen.getByText("Keep briefs concise")).toBeTruthy();
  fireEvent.press(screen.getByText("Confirm memory"));
  await waitFor(() => expect(onMemory).toHaveBeenCalledWith("mem_abcdefgh", "confirm", { baseRevision: 1 }));
  fireEvent.press(screen.getByText("Revoke Work"));
  await waitFor(() => expect(onRevoke).toHaveBeenCalledWith("gr_abcdefgh"));
}, 20_000);

it("keeps a resolved connect request settled when opening consent fails", async () => {
  const connect = { ...snapshot.interactions[0], kind: "connect_request",
    payload: { kind: "connect_request", service: "gmail", access: ["read"], benefit: "Read your inbox",
      connectRequestId: "cr_abcdefgh" } };
  const onResolve = jest.fn(async () => ({ interaction: { interactionId: "in_abcdefgh", status: "resolved", revision: 2 },
    connectUrl: "https://example.com/consent" }));
  const onConnectUrl = jest.fn(async () => { throw new Error("Native browser unavailable"); });
  render(<BotChatControls snapshot={{ ...snapshot, interactions: [connect] } as never}
    onResolve={onResolve as never} onRevoke={jest.fn()} onMemory={jest.fn()} onRefresh={jest.fn()}
    onConnectUrl={onConnectUrl} />);
  fireEvent.press(screen.getByText("Connect"));
  await waitFor(() => expect(screen.getByText("Continue connecting")).toBeTruthy());
  fireEvent.press(screen.getByText("Continue connecting"));
  await waitFor(() => expect(screen.getByText("Could not open the connection page. Try again.")).toBeTruthy());
  expect(screen.queryByText("Could not save your response. Try again.")).toBeNull();
}, 20_000);
