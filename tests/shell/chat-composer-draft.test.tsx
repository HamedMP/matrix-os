// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
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
