// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createChatComposerDraftKeeper, useChatComposerDraft } from "../../shell/src/components/chat/useChatComposerDraft";

afterEach(cleanup);

it("rotates permission identity on external replacement while preserving it through ordinary editing", () => {
  const { result } = renderHook(() => useChatComposerDraft("new:1", "gateway"));
  const agent = { kind: "agent" as const, id: "bot_helper", label: "Helper" };
  act(() => result.current.setDraft({ text: "First recipe", resources: [agent] }));
  const firstIdentity = result.current.permissionIdentity;
  expect(firstIdentity).toBeTruthy();
  act(() => result.current.setText("First recipe with details"));
  expect(result.current.permissionIdentity).toBe(firstIdentity);
  act(() => result.current.setResources([agent, { kind: "chat", id: "chat_notes", label: "Notes" }]));
  expect(result.current.permissionIdentity).toBe(firstIdentity);
  act(() => result.current.setDraft({ text: "A replacement recipe", resources: [agent] }));
  expect(result.current.permissionIdentity).not.toBe(firstIdentity);
});

it("gives a remounted view the kept question and references of its Chat, and none from another gateway", () => {
  const keeper = createChatComposerDraftKeeper();
  const reference = { kind: "chat" as const, id: "chat_notes", label: "Notes" };
  const first = renderHook(() => useChatComposerDraft("chat_a", "gateway", keeper));
  act(() => first.result.current.setDraft({ text: "What shipped in", resources: [reference] }));
  first.unmount();
  const again = renderHook(() => useChatComposerDraft("chat_a", "gateway", keeper));
  expect(again.result.current).toMatchObject({ text: "What shipped in", resources: [reference] });
  act(() => again.result.current.clear());
  again.unmount();
  expect(renderHook(() => useChatComposerDraft("chat_a", "gateway", keeper)).result.current.text).toBe("");
  const other = renderHook(() => useChatComposerDraft("chat_b", "gateway", keeper));
  act(() => other.result.current.setText("Kept"));
  other.unmount();
  expect(renderHook(() => useChatComposerDraft("chat_b", "other-gateway", keeper)).result.current.text).toBe("");
});

it("lets a question go once it is sent, even after its view was switched away, but keeps a newer one", () => {
  const keeper = createChatComposerDraftKeeper();
  const sending = renderHook(() => useChatComposerDraft("chat_a", "gateway", keeper));
  act(() => sending.result.current.setText("What shipped in"));
  const sent = sending.result.current.clear;
  // The viewer opens another Chat, then comes back, while the question is still on its way.
  sending.unmount();
  const other = renderHook(() => useChatComposerDraft("chat_b", "gateway", keeper));
  act(() => other.result.current.setText("Which tests"));
  other.unmount();
  const back = renderHook(() => useChatComposerDraft("chat_a", "gateway", keeper));
  expect(back.result.current.text).toBe("What shipped in");
  act(() => sent());
  expect(back.result.current.text).toBe("");
  act(() => back.result.current.setText("And since then?"));
  back.unmount();
  expect(renderHook(() => useChatComposerDraft("chat_b", "gateway", keeper)).result.current.text).toBe("Which tests");
  // A send that settles after a newer question was typed leaves that question in place.
  const newer = renderHook(() => useChatComposerDraft("chat_a", "gateway", keeper));
  const stale = newer.result.current.clear;
  act(() => newer.result.current.setText("And since then, really?"));
  act(() => stale());
  expect(newer.result.current.text).toBe("And since then, really?");
});

it("puts a returned question back under its Chat in the open view and for later views, for that owner only", () => {
  const keeper = createChatComposerDraftKeeper();
  const reference = { kind: "chat" as const, id: "chat_notes", label: "Notes" };
  const open = renderHook(() => useChatComposerDraft("chat_b", "gateway", keeper));
  act(() => keeper.restore({ identity: "other-gateway", scope: "chat_c", text: "Not mine", resources: [] }));
  act(() => keeper.restore({ identity: "gateway", scope: "chat_a", text: "What shipped in", resources: [reference] }));
  // The open view writes its drafts back on its next edit: the returned question must ride along.
  act(() => open.result.current.setText("Which tests"));
  open.unmount();
  const back = renderHook(() => useChatComposerDraft("chat_a", "gateway", keeper));
  expect(back.result.current).toMatchObject({ text: "What shipped in", resources: [reference] });
  // Like any question set from outside, its references need fresh consent.
  expect(back.result.current.permissionIdentity).toBe(back.result.current.requestId);
  expect(renderHook(() => useChatComposerDraft("chat_c", "gateway", keeper)).result.current.text).toBe("");
});

it("keeps a question typed since when a returned question comes back, without doubling either", () => {
  const keeper = createChatComposerDraftKeeper();
  const notes = { kind: "chat" as const, id: "chat_notes", label: "Notes" };
  const plan = { kind: "chat" as const, id: "chat_plan", label: "Plan" };
  // The viewer typed the next question in the new Chat before its first one was refused.
  const open = renderHook(() => useChatComposerDraft("chat_new", "gateway", keeper));
  act(() => open.result.current.setDraft({ text: "Which tests?", resources: [plan, notes] }));
  act(() => keeper.restore({ identity: "gateway", scope: "chat_new", text: "Why did it change?", resources: [notes] }));
  expect(open.result.current).toMatchObject({ text: "Why did it change?\n\nWhich tests?", resources: [plan, notes] });
  open.unmount();
  const back = renderHook(() => useChatComposerDraft("chat_new", "gateway", keeper));
  expect(back.result.current.text).toBe("Why did it change?\n\nWhich tests?");
  // The same question again is not added twice.
  act(() => back.result.current.setDraft({ text: "Why did it change?", resources: [] }));
  act(() => keeper.restore({ identity: "gateway", scope: "chat_new", text: "Why did it change?", resources: [notes] }));
  expect(back.result.current).toMatchObject({ text: "Why did it change?", resources: [notes] });
});

it("holds a returned question whose references do not fit beside the ones typed since until that one is sent", () => {
  const keeper = createChatComposerDraftKeeper();
  const chat = (id: string) => ({ kind: "chat" as const, id: `chat_${id}`, label: id });
  const typed = [chat("plan"), chat("notes"), chat("tests")];
  const refused = [chat("notes"), chat("release")];
  const open = renderHook(() => useChatComposerDraft("chat_new", "gateway", keeper));
  act(() => open.result.current.setDraft({ text: "Which tests?", resources: typed }));
  act(() => keeper.restore({ identity: "gateway", scope: "chat_new", text: "Why did it change?", resources: refused }));
  // A Chat takes three Chat references: neither question is cut down, and the one typed since stays as it was.
  expect(open.result.current).toMatchObject({ text: "Which tests?", resources: typed });
  open.unmount();
  const back = renderHook(() => useChatComposerDraft("chat_new", "gateway", keeper));
  expect(back.result.current).toMatchObject({ text: "Which tests?", resources: typed });
  // Once that question is sent, the refused one comes back whole, and its references need fresh consent.
  act(() => back.result.current.clear());
  expect(back.result.current).toMatchObject({ text: "Why did it change?", resources: refused });
  expect(back.result.current.permissionIdentity).toBe(back.result.current.requestId);
  back.unmount();
  const later = renderHook(() => useChatComposerDraft("chat_new", "gateway", keeper));
  expect(later.result.current).toMatchObject({ text: "Why did it change?", resources: refused });
  act(() => later.result.current.clear());
  expect(later.result.current.text).toBe("");
});

it("bounds the keeper's listeners to a few views, dropping the oldest", () => {
  const keeper = createChatComposerDraftKeeper();
  const listeners = Array.from({ length: 100 }, () => vi.fn());
  for (const listener of listeners) keeper.subscribe(listener);
  keeper.settle({ identity: "gateway", scope: "chat_a", requestId: "req_sent" });
  expect(listeners.filter((listener) => listener.mock.calls.length > 0).length).toBeLessThanOrEqual(4);
  expect(listeners[0]).not.toHaveBeenCalled();
  expect(listeners.at(-1)).toHaveBeenCalledTimes(1);
});

it("never brings a sent question back to a view opened on another Chat when the send settles", () => {
  const keeper = createChatComposerDraftKeeper();
  const sending = renderHook(() => useChatComposerDraft("chat_a", "gateway", keeper));
  act(() => sending.result.current.setText("What shipped in"));
  const sent = sending.result.current.clear;
  sending.unmount();
  const other = renderHook(() => useChatComposerDraft("chat_b", "gateway", keeper));
  act(() => sent());
  // The open view writes its drafts back on its next edit: the sent question must not ride along.
  act(() => other.result.current.setText("Which tests"));
  other.unmount();
  expect(renderHook(() => useChatComposerDraft("chat_a", "gateway", keeper)).result.current.text).toBe("");
});
