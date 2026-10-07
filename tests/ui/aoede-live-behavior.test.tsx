// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { AoedeLivePanel } from "../../packages/ui/src/aoede/AoedeLivePanel";
import { ChatPresentation } from "../../packages/ui/src/chat/ChatPresentation";
import type { AoedePanelProps } from "../../packages/ui/src/aoede/AoedePanel";
afterEach(cleanup);
const props: AoedePanelProps = { scopeLabel: "Workspace", status: "speaking", turnMode: "hands_free",
  microphoneActive: true, conversationKey: "chat_a", captions: { response: "First answer" },
  commands: { start: vi.fn(), dismiss: vi.fn(), end: vi.fn(), pause: vi.fn(), resume: vi.fn(),
    stopSpeaking: vi.fn(), pushToTalkStart: vi.fn(), pushToTalkStop: vi.fn(), retry: vi.fn(),
    newConversation: vi.fn(), viewHistory: vi.fn() } };
it("excludes shared chats and portal captions from session recording", () => {
  render(<><ChatPresentation><p>Private transcript</p></ChatPresentation><AoedeLivePanel {...props} /></>);
  expect(screen.getByText("Private transcript").closest(".ph-no-capture")).not.toBeNull();
  expect(screen.getByRole("region", { name: "Current response" }).closest(".ph-no-capture")).not.toBeNull();
});
it("follows streamed captions while at the bottom but preserves a reader's scroll position", () => {
  const view = render(<AoedeLivePanel {...props} />);
  const captions = screen.getByRole("region", { name: "Current response" }).parentElement!;
  Object.defineProperties(captions, { scrollHeight: { value: 800, configurable: true },
    clientHeight: { value: 200, configurable: true } });
  captions.scrollTop = 0;
  view.rerender(<AoedeLivePanel {...props} captions={{ response: "Second answer" }} />);
  expect(captions.scrollTop).toBe(600);
  captions.scrollTop = 100; fireEvent.scroll(captions);
  view.rerender(<AoedeLivePanel {...props} captions={{ response: "More streaming text" }} />);
  expect(captions.scrollTop).toBe(100);
  captions.scrollTop = 600; fireEvent.scroll(captions);
  Object.defineProperty(captions, "scrollHeight", { value: 1000 });
  view.rerender(<AoedeLivePanel {...props} captions={{ response: "Newest streaming text" }} />);
  expect(captions.scrollTop).toBe(800);
  captions.scrollTop = 50; fireEvent.scroll(captions);
  view.rerender(<AoedeLivePanel {...props} conversationKey="chat_b" captions={{ response: "New conversation" }} />);
  expect(captions.scrollTop).toBe(800);
});
