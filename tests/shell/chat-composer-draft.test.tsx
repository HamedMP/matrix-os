// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { useChatComposerDraft } from "../../shell/src/components/chat/useChatComposerDraft";

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
