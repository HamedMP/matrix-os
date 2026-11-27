// @vitest-environment jsdom
import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ChatApp } from "../../shell/src/components/ChatApp";
import { ConversationTranscript } from "../../desktop/src/renderer/src/components/conversation/transcript";
import { canonicalChatPresentation } from "../../desktop/src/renderer/src/features/chat/canonical-chat-presentation";
import { projectCanonicalTranscript } from "../../shell/src/lib/canonical-chat-terminal-notices";
import { RoutineMessageMeta } from "../../packages/ui/src/chat-agents/bots/RoutineMessage";
import { ScheduledMessageMeta } from "../../packages/ui/src/chat/ScheduledMessageMeta";
import { nativeScheduledMessageFixture } from "../helpers/native-scheduled-message-fixture";
import { routineMessageFixture } from "../helpers/routine-message-fixture";
import { createCanonicalProviderCatalogFixture } from "../contracts/fixtures/canonical-chat";

vi.mock("@clerk/nextjs", async original => ({ ...await original<typeof import("@clerk/nextjs")>(), useOrganization: () => ({ organization: null }), useAuth: () => ({ userId: null, sessionId: null }) }));
vi.mock("../../shell/src/components/chat-provider-onboarding", () => ({ ChatProviderOnboarding: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("fetch", vi.fn(async () => Response.json(createCanonicalProviderCatalogFixture())));
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it.each([false, true])("shows the scheduled reply without a generated input on Web (mobile=%s), including live updates", mobile => {
  const detail = nativeScheduledMessageFixture();
  const props = { mobile, busy: false, connected: true, conversations: [], onNewChat: vi.fn(), onSwitchConversation: vi.fn(), onSubmit: vi.fn() };
  const view = render(<ChatApp {...props} messages={projectCanonicalTranscript(detail)} sessionId={detail.record.chat.id}/>);
  expect(screen.queryByText("Sent by scheduled task")).toBeNull();
  expect(screen.queryByText("Scheduled task triggered.")).toBeNull();
  expect(screen.getByText("Scheduled result.")).toBeTruthy();
  detail.messages[1]!.parts = [{ type: "text", text: "Streaming reply grew." }];
  view.rerender(<ChatApp {...props} messages={projectCanonicalTranscript(detail)} sessionId={detail.record.chat.id}/>);
  expect(screen.queryByText("Scheduled task triggered.")).toBeNull();
  expect(screen.getByText("Streaming reply grew.")).toBeTruthy();
  detail.messages[0]!.role = "user"; detail.messages[0]!.purpose = "ai_request";
  view.rerender(<ChatApp {...props} messages={projectCanonicalTranscript(detail)} sessionId="chat_manual"/>);
  expect(screen.queryByText("Sent by scheduled task")).toBeNull();
  expect(screen.getByText("Scheduled task triggered.")).toBeTruthy();
});

it("shows the scheduled reply without a fake user bubble in the actual Electron transcript", () => {
  const detail = nativeScheduledMessageFixture();
  const view = render(<ConversationTranscript turns={canonicalChatPresentation(detail)} callbacks={{ copyText: vi.fn() }}/>);
  const inputId = detail.messages[0]!.id;
  expect(screen.getByText("Scheduled result.")).toBeTruthy();
  expect(screen.queryByText("Sent by scheduled task")).toBeNull();
  expect(view.container.querySelector(`[data-message-id="user:${inputId}"]`)).toBeNull();
  detail.messages[0]!.role = "user"; detail.messages[0]!.purpose = "ai_request";
  view.rerender(<ConversationTranscript turns={canonicalChatPresentation(detail)} callbacks={{ copyText: vi.fn() }}/>);
  expect(screen.getByText("Scheduled task triggered.")).toBeTruthy();
});

it("preserves the shared schedule clock and label outside the transcript input", () => {
  const saved = routineMessageFixture();
  const occurrence = { routine: saved.routine, fire: saved.history[0]! };
  const rows = render(<><RoutineMessageMeta occurrence={occurrence}/><ScheduledMessageMeta timestamp={occurrence.fire.scheduledFor}/></>);
  const metas = rows.container.querySelectorAll("[data-scheduled-message]");
  expect(metas[0]!.innerHTML).toBe(metas[1]!.innerHTML);
});


it.each(["electron", "web", "web-mobile"])("keeps a long generated prompt out of %s, including copy and expansion controls", surface => {
  const detail = nativeScheduledMessageFixture();
  const text = "Only the safe stored message is available. ".repeat(10);
  detail.messages[0]!.parts = [{ type: "text", text }];
  const view = render(surface === "electron"
    ? <ConversationTranscript turns={canonicalChatPresentation(detail)} callbacks={{ copyText: vi.fn() }}/>
    : <ChatApp mobile={surface === "web-mobile"} busy={false} connected conversations={[]}
        messages={projectCanonicalTranscript(detail)} sessionId={detail.record.chat.id}
        onNewChat={vi.fn()} onSwitchConversation={vi.fn()} onSubmit={vi.fn()}/>);
  expect(view.container.textContent).not.toContain(text.trim());
  expect(screen.queryByRole("button", { name: /Show full message|Show more/ })).toBeNull();
  expect(screen.getByText("Scheduled result.")).toBeTruthy();
});
