import React from "react";
import { Modal } from "react-native";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { BotChatControls } from "@/components/BotChatControls";
import { BotRecipeChooser } from "@/components/BotRecipeChooser";

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
  render(<BotChatControls scopeKey="owner:gateway:chat" snapshot={snapshot as never} onResolve={onResolve as never} onRevoke={onRevoke}
    onMemory={onMemory} onRefresh={jest.fn()} />);
  expect(screen.getByText("Research Rabbit")).toBeTruthy();
  expect(screen.getByText("Waiting for your answer")).toBeTruthy();
  fireEvent.changeText(screen.getByLabelText("Answer Target"), "Acme");
  fireEvent.press(screen.getByText("Brief"));
  fireEvent.press(screen.getByText("Answer"));
  await waitFor(() => expect(onResolve).toHaveBeenCalledWith("in_abcdefgh", {
    kind: "question", baseRevision: 1, structuredAnswers: { target: ["Acme"], format: ["Brief"] },
  }));
  fireEvent.press(screen.getByRole("button", { name: "Bot settings" }));
  expect(screen.queryByText("Keep briefs concise")).toBeNull();
  fireEvent.press(screen.getByRole("tab", { name: "Memory (1)" }));
  expect(screen.getByText("Keep briefs concise")).toBeTruthy();
  fireEvent.press(screen.getByText("Confirm memory"));
  await waitFor(() => expect(onMemory).toHaveBeenCalledWith("mem_abcdefgh", "confirm", { baseRevision: 1 }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Forget memory" }).props.accessibilityState.disabled).toBe(false));
  fireEvent.press(screen.getByRole("tab", { name: "Connections (1)" }));
  fireEvent.press(screen.getByText("Revoke Work"));
  await waitFor(() => expect(onRevoke).toHaveBeenCalledWith("gr_abcdefgh"));
}, 20_000);

it("reuses the bot creation request ID on retry and opens the new Chat", async () => {
  const onCreate = jest.fn().mockRejectedValueOnce(new Error("response lost"))
    .mockResolvedValueOnce("chat_research");
  const onOpenChat = jest.fn();
  render(<BotRecipeChooser recipes={[{ recipeId: "inbox-triage", version: "v1",
    name: "Inbox helper", description: "Summarize the inbox", output: "A daily brief" }]}
    onCreate={onCreate} onOpenChat={onOpenChat} />);
  fireEvent.press(screen.getByText("Build in Chat"));
  await waitFor(() => expect(screen.getByText("Bot could not be created. Try again.")).toBeTruthy());
  fireEvent.press(screen.getByText("Build in Chat"));
  await waitFor(() => expect(onOpenChat).toHaveBeenCalledWith("chat_research"));
  expect(onCreate.mock.calls[0]![1]).toBe(onCreate.mock.calls[1]![1]);
}, 20_000);

it("reuses a creation request after the chooser closes and reopens", async () => {
  const onCreate = jest.fn().mockRejectedValueOnce(new Error("response lost"))
    .mockResolvedValueOnce("chat_research");
  const onOpenChat = jest.fn();
  const attemptRef = { current: null };
  const chooser = () => <BotRecipeChooser recipes={[{ recipeId: "inbox-triage", version: "v1",
    name: "Inbox helper", description: "Summarize the inbox", output: "A daily brief" }]}
    onCreate={onCreate} onOpenChat={onOpenChat} attemptRef={attemptRef} attemptScope="owner:gateway" />;
  const view = render(chooser());
  fireEvent.press(screen.getByText("Build in Chat"));
  await waitFor(() => expect(screen.getByText("Bot could not be created. Try again.")).toBeTruthy());
  view.unmount();
  const reopened = render(chooser());
  fireEvent.press(reopened.getByText("Build in Chat"));
  await waitFor(() => expect(onOpenChat).toHaveBeenCalledWith("chat_research"));
  expect(onCreate.mock.calls[0]![1]).toBe(onCreate.mock.calls[1]![1]);
}, 20_000);

it("keeps the selected option when an Other answer is typed then cleared", async () => {
  const onResolve = jest.fn(async () => ({ interaction: { interactionId: "in_abcdefgh", status: "resolved", revision: 2 } }));
  const question = { ...snapshot.interactions[0], payload: { kind: "question", questions: [
    { questionId: "format", header: "Format", question: "Which format?", allowOther: true, secret: false,
      options: [{ label: "Brief", description: "One page" }] },
  ] } };
  render(<BotChatControls scopeKey="owner:gateway:chat" snapshot={{ ...snapshot, interactions: [question] } as never}
    onResolve={onResolve as never} onRevoke={jest.fn()} onMemory={jest.fn()} onRefresh={jest.fn()} />);
  fireEvent.press(screen.getByText("Brief"));
  fireEvent.changeText(screen.getByLabelText("Answer Format"), "Detailed");
  fireEvent.changeText(screen.getByLabelText("Answer Format"), "");
  expect(screen.getByRole("button", { name: "Answer" }).props.accessibilityState.disabled).toBe(false);
  fireEvent.press(screen.getByText("Answer"));
  await waitFor(() => expect(onResolve).toHaveBeenCalledWith("in_abcdefgh", {
    kind: "question", baseRevision: 1, structuredAnswers: { format: ["Brief"] },
  }));
}, 20_000);

it("does not let an older create completion erase a newer retry ID", async () => {
  let finishOlder!: (chatId: string) => void;
  const older = new Promise<string>((resolve) => { finishOlder = resolve; });
  const onCreate = jest.fn().mockReturnValueOnce(older)
    .mockRejectedValueOnce(new Error("response lost"))
    .mockResolvedValueOnce("chat_newer");
  const onOpenChat = jest.fn();
  const attemptRef = { current: null };
  const recipes = [
    { recipeId: "inbox-triage", version: "v1", name: "Inbox helper", description: "Inbox", output: "Brief" },
    { recipeId: "competitor-watching", version: "v1", name: "Market helper", description: "Market", output: "Report" },
  ];
  const chooser = () => <BotRecipeChooser recipes={recipes} onCreate={onCreate} onOpenChat={onOpenChat}
    attemptRef={attemptRef} attemptScope="owner:gateway" />;
  const first = render(chooser());
  fireEvent.press(first.getByRole("button", { name: "Use Inbox helper" }));
  first.unmount();
  const second = render(chooser());
  fireEvent.press(second.getByRole("button", { name: "Use Market helper" }));
  await waitFor(() => expect(second.getByText("Bot could not be created. Try again.")).toBeTruthy());
  const newerRequestId = onCreate.mock.calls[1]![1];
  finishOlder("chat_older");
  await waitFor(() => expect(onOpenChat).toHaveBeenCalledWith("chat_older"));
  fireEvent.press(second.getByRole("button", { name: "Use Market helper" }));
  await waitFor(() => expect(onOpenChat).toHaveBeenCalledWith("chat_newer"));
  expect(onCreate.mock.calls[2]![1]).toBe(newerRequestId);
}, 20_000);

it("keeps a resolved connect request settled when opening consent fails", async () => {
  const connect = { ...snapshot.interactions[0], kind: "connect_request",
    payload: { kind: "connect_request", service: "gmail", access: ["read"], benefit: "Read your inbox",
      connectRequestId: "cr_abcdefgh" } };
  const onResolve = jest.fn(async () => ({ interaction: { interactionId: "in_abcdefgh", status: "resolved", revision: 2 },
    connectUrl: "https://example.com/consent" }));
  const onConnectUrl = jest.fn(async () => { throw new Error("Native browser unavailable"); });
  render(<BotChatControls scopeKey="owner:gateway:chat" snapshot={{ ...snapshot, interactions: [connect] } as never}
    onResolve={onResolve as never} onRevoke={jest.fn()} onMemory={jest.fn()} onRefresh={jest.fn()}
    onConnectUrl={onConnectUrl} />);
  fireEvent.press(screen.getByText("Connect"));
  await waitFor(() => expect(screen.getByText("Continue connecting")).toBeTruthy());
  fireEvent.press(screen.getByText("Continue connecting"));
  await waitFor(() => expect(screen.getByText("Could not open the connection page. Try again.")).toBeTruthy());
  expect(screen.queryByText("Could not save your response. Try again.")).toBeNull();
}, 20_000);

it("shows cached bot status read-only after a refresh fails", () => {
  render(<BotChatControls scopeKey="owner:gateway:chat" snapshot={snapshot as never} actionsAvailable={false}
    onResolve={jest.fn()} onRevoke={jest.fn()} onMemory={jest.fn()} onRefresh={jest.fn()} />);
  expect(screen.getByText("Which company?")).toBeTruthy();
  expect(screen.queryByText("Answer")).toBeNull();
  fireEvent.press(screen.getByRole("button", { name: "Bot settings" }));
  expect(screen.getByRole("button", { name: "Revoke Work" }).props.accessibilityState.disabled).toBe(true);
});

function renderBot(overrides: Partial<React.ComponentProps<typeof BotChatControls>> = {}) {
  return render(<BotChatControls scopeKey="owner:gateway:chat" snapshot={snapshot as never} onResolve={jest.fn()} onRevoke={jest.fn()}
    onMemory={jest.fn()} onRefresh={jest.fn()} {...overrides} />);
}

it("keeps settings in a separate sheet and preserves the question draft across sections and close", () => {
  const view = renderBot();
  fireEvent.changeText(screen.getByLabelText("Answer Target"), "Acme draft");
  fireEvent.press(screen.getByRole("button", { name: "Bot settings" }));
  expect(screen.getByText("Gmail")).toBeTruthy();
  expect(screen.getByText("Access allowed")).toBeTruthy();
  expect(screen.getByText("Read")).toBeTruthy();
  expect(screen.queryByText("Keep briefs concise")).toBeNull();
  fireEvent.press(screen.getByRole("tab", { name: "Memory (1)" }));
  expect(screen.getByText("Keep briefs concise")).toBeTruthy();
  expect(screen.queryByText("Gmail")).toBeNull();
  fireEvent.press(screen.getByRole("tab", { name: "Routines (0)" }));
  expect(screen.getByText("No routines yet. Ask your bot to set one up.")).toBeTruthy();
  fireEvent.press(screen.getByRole("button", { name: "Close bot settings" }));
  expect(screen.queryByText("No routines yet. Ask your bot to set one up.")).toBeNull();
  expect(screen.getByLabelText("Answer Target").props.value).toBe("Acme draft");
  fireEvent.press(screen.getByRole("button", { name: "Bot settings" }));
  view.rerender(<BotChatControls scopeKey="owner:gateway:chat" snapshot={{ ...snapshot, agentId: "bot_other", name: "Other bot" } as never}
    onResolve={jest.fn()} onRevoke={jest.fn()} onMemory={jest.fn()} onRefresh={jest.fn()} />);
  expect(screen.queryByRole("button", { name: "Close bot settings" })).toBeNull();
  fireEvent.press(screen.getByRole("button", { name: "Bot settings" }));
  expect(screen.getByText("Gmail")).toBeTruthy();
});

it("retains memory while a mutation is pending or fails without exposing provider errors", async () => {
  let reject!: (error: Error) => void;
  const onMemory = jest.fn(() => new Promise((_, fail) => { reject = fail; }));
  renderBot({ onMemory });
  fireEvent.press(screen.getByRole("button", { name: "Bot settings" }));
  fireEvent.press(screen.getByRole("tab", { name: "Memory (1)" }));
  fireEvent.press(screen.getByRole("button", { name: "Forget memory" }));
  expect(screen.getByText("Keep briefs concise")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Confirm memory" }).props.accessibilityState.disabled).toBe(true);
  await act(async () => reject(new Error("Postgres secret internal path")));
  expect(screen.getByText("Could not update bot settings. Try again.")).toBeTruthy();
  expect(screen.queryByText("Postgres secret internal path")).toBeNull();
  expect(screen.getByText("Keep briefs concise")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Forget memory" }).props.accessibilityState.disabled).toBe(false);
});

it("keeps a confirmed removal after refresh fails and requires a successful retry for further actions", async () => {
  const onRefresh = jest.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(undefined);
  renderBot({ onRefresh });
  fireEvent.press(screen.getByRole("button", { name: "Bot settings" }));
  fireEvent.press(screen.getByRole("button", { name: "Revoke Work" }));
  await waitFor(() => expect(screen.getByText("Bot settings could not be loaded. Try again.")).toBeTruthy());
  expect(screen.queryByRole("button", { name: "Revoke Work" })).toBeNull();
  fireEvent.press(screen.getByRole("tab", { name: "Memory (1)" }));
  expect(screen.getByRole("button", { name: "Forget memory" }).props.accessibilityState.disabled).toBe(true);
  fireEvent.press(screen.getByRole("button", { name: "Retry bot settings" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Forget memory" }).props.accessibilityState.disabled).toBe(false));
});

it("does not refresh or apply an old mutation to a different bot", async () => {
  let finish!: () => void;
  const onMemory = jest.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
  const onRefresh = jest.fn();
  const view = renderBot({ onMemory, onRefresh });
  fireEvent.press(screen.getByRole("button", { name: "Bot settings" }));
  fireEvent.press(screen.getByRole("tab", { name: "Memory (1)" }));
  fireEvent.press(screen.getByRole("button", { name: "Forget memory" }));
  view.rerender(<BotChatControls scopeKey="owner:gateway:chat" snapshot={{ ...snapshot, agentId: "bot_other", name: "Other bot" } as never}
    onResolve={jest.fn()} onRevoke={jest.fn()} onMemory={jest.fn()} onRefresh={onRefresh} />);
  await act(async () => finish());
  expect(onRefresh).not.toHaveBeenCalled();
  fireEvent.press(screen.getByRole("button", { name: "Bot settings" }));
  fireEvent.press(screen.getByRole("tab", { name: "Memory (1)" }));
  expect(screen.getByText("Keep briefs concise")).toBeTruthy();
});

it("closes the native settings sheet through the operating-system back action", () => {
  renderBot();
  fireEvent.press(screen.getByRole("button", { name: "Bot settings" }));
  fireEvent(screen.UNSAFE_getByType(Modal), "requestClose");
  expect(screen.queryByRole("button", { name: "Close bot settings" })).toBeNull();
});

it("shows scheduled routine status without inventing editing actions", () => {
  renderBot({ snapshot: { ...snapshot, authority: { ...snapshot.authority, routines: [
    { routineId: "routine_1", summary: "Send a morning brief", status: "active", nextFireAt: "2026-10-01T08:00:00.000Z" },
    { routineId: "routine_2", summary: "Weekly roundup", status: "paused", nextFireAt: null },
  ] } } as never });
  fireEvent.press(screen.getByRole("button", { name: "Bot settings" }));
  fireEvent.press(screen.getByRole("tab", { name: "Routines (2)" }));
  expect(screen.getByText("Send a morning brief")).toBeTruthy();
  expect(screen.getByText("Active")).toBeTruthy();
  expect(screen.getByText("Paused")).toBeTruthy();
  expect(screen.getByText(/Next run/)).toBeTruthy();
});

it("keeps stale settings disabled when a retry fails", async () => {
  const onRefresh = jest.fn().mockRejectedValueOnce(new Error("internal hostname"));
  const onRevoke = jest.fn();
  renderBot({ actionsAvailable: false, onRefresh, onRevoke });
  fireEvent.press(screen.getByRole("button", { name: "Bot settings" }));
  fireEvent.press(screen.getByRole("button", { name: "Revoke Work" }));
  expect(onRevoke).not.toHaveBeenCalled();
  fireEvent.press(screen.getByRole("button", { name: "Retry bot settings" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Retry bot settings" }).props.accessibilityState.disabled).toBe(false));
  expect(screen.getByRole("button", { name: "Revoke Work" }).props.accessibilityState.disabled).toBe(true);
  expect(screen.queryByText("internal hostname")).toBeNull();
});

it("shows connection and memory empty states from the saved snapshot", () => {
  renderBot({ snapshot: { ...snapshot, authority: { ...snapshot.authority,
    grants: [], connections: [], memory: { items: [] },
  } } as never });
  fireEvent.press(screen.getByRole("button", { name: "Bot settings" }));
  expect(screen.getByText("No connections yet")).toBeTruthy();
  fireEvent.press(screen.getByRole("tab", { name: "Memory (0)" }));
  expect(screen.getByText("Nothing remembered yet.")).toBeTruthy();
});

it("only removes a memory after a successful revisioned forget and retains that result on failed refresh", async () => {
  let finish!: () => void;
  const onMemory = jest.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
  renderBot({ onMemory, onRefresh: jest.fn().mockRejectedValueOnce(new Error("offline")) });
  fireEvent.press(screen.getByRole("button", { name: "Bot settings" }));
  fireEvent.press(screen.getByRole("tab", { name: "Memory (1)" }));
  fireEvent.press(screen.getByRole("button", { name: "Forget memory" }));
  expect(onMemory).toHaveBeenCalledWith("mem_abcdefgh", "forget", { baseRevision: 1 });
  expect(screen.getByText("Keep briefs concise")).toBeTruthy();
  await act(async () => finish());
  expect(screen.queryByText("Keep briefs concise")).toBeNull();
  expect(screen.getByText("Nothing remembered yet.")).toBeTruthy();
  fireEvent.press(screen.getByRole("button", { name: "Close bot settings" }));
  fireEvent.press(screen.getByRole("button", { name: "Bot settings" }));
  expect(screen.queryByText("Keep briefs concise")).toBeNull();
});

it("shows the same settings copy and memory provenance as the Web inspector", () => {
  renderBot({ snapshot: { ...snapshot, authority: { ...snapshot.authority, memory: { items: [
    { ...snapshot.authority.memory.items[0], itemId: "chat_memory", source: { at: "2026-09-28T12:00:00.000Z", messageId: "msg_abcdefgh" } },
    { ...snapshot.authority.memory.items[0], itemId: "web_memory", content: "A source fact", confirmed: true,
      source: { at: "2026-09-29T12:00:00.000Z", url: "https://example.com/fact" } },
    { ...snapshot.authority.memory.items[0], itemId: "other_memory", content: "A preference", source: { at: "2026-09-30T12:00:00.000Z" } },
  ] } } } as never });
  fireEvent.press(screen.getByRole("button", { name: "Bot settings" }));
  expect(screen.getByText("Only the access you've allowed for this bot.")).toBeTruthy();
  fireEvent.press(screen.getByRole("tab", { name: "Memory (3)" }));
  expect(screen.getByText("What your bot remembers")).toBeTruthy();
  expect(screen.getByText("Preferences and context saved for this bot. You can forget them anytime.")).toBeTruthy();
  expect(screen.getByText("From Chat · 2026-09-28")).toBeTruthy();
  expect(screen.getByText("From a web source · 2026-09-29")).toBeTruthy();
  expect(screen.getByText("Remembered · 2026-09-30")).toBeTruthy();
  expect(screen.getByText("Confirmed")).toBeTruthy();
  expect(screen.getAllByText("Needs confirmation")).toHaveLength(2);
  fireEvent.press(screen.getByRole("tab", { name: "Routines (0)" }));
  expect(screen.getByText("Scheduled work for this bot.")).toBeTruthy();
});

it("resets same-ID settings when the owner, runtime or Chat scope changes during a mutation", async () => {
  let finish!: () => void;
  const onMemory = jest.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
  const onRefresh = jest.fn();
  const view = renderBot({ scopeKey: "owner-a:runtime-a:chat-a", onMemory, onRefresh });
  fireEvent.press(screen.getByRole("button", { name: "Bot settings" }));
  fireEvent.press(screen.getByRole("tab", { name: "Memory (1)" }));
  fireEvent.press(screen.getByRole("button", { name: "Forget memory" }));
  view.rerender(<BotChatControls scopeKey="owner-a:runtime-b:chat-a" snapshot={snapshot as never}
    onResolve={jest.fn()} onRevoke={jest.fn()} onMemory={jest.fn()} onRefresh={onRefresh} />);
  expect(screen.queryByRole("button", { name: "Close bot settings" })).toBeNull();
  await act(async () => finish());
  expect(onRefresh).not.toHaveBeenCalled();
  fireEvent.press(screen.getByRole("button", { name: "Bot settings" }));
  expect(screen.getByText("Gmail")).toBeTruthy();
  fireEvent.press(screen.getByRole("tab", { name: "Memory (1)" }));
  expect(screen.getByText("Keep briefs concise")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Forget memory" }).props.accessibilityState.disabled).toBe(false);
});

it("does not carry confirmed removals to another same-ID owner or Chat scope", async () => {
  const view = renderBot({ scopeKey: "owner-a:runtime-a:chat-a" });
  fireEvent.press(screen.getByRole("button", { name: "Bot settings" }));
  fireEvent.press(screen.getByRole("button", { name: "Revoke Work" }));
  await waitFor(() => expect(screen.queryByRole("button", { name: "Revoke Work" })).toBeNull());
  view.rerender(<BotChatControls scopeKey="owner-b:runtime-a:chat-b" snapshot={snapshot as never}
    onResolve={jest.fn()} onRevoke={jest.fn()} onMemory={jest.fn()} onRefresh={jest.fn()} />);
  fireEvent.press(screen.getByRole("button", { name: "Bot settings" }));
  expect(screen.getByRole("button", { name: "Revoke Work" })).toBeTruthy();
});
