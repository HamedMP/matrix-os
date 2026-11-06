// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ChatApp } from "../../shell/src/components/ChatApp";
import { UserMessage } from "../../desktop/src/renderer/src/components/conversation/user-message";
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

it.each([false, true])("draws the native annotation on its exact Web input (mobile=%s), once through streaming and Chat changes", mobile => {
  const detail = nativeScheduledMessageFixture();
  const props = { mobile, busy: false, connected: true, conversations: [], onNewChat: vi.fn(), onSwitchConversation: vi.fn(), onSubmit: vi.fn() };
  const view = render(<ChatApp {...props} messages={projectCanonicalTranscript(detail)} sessionId={detail.record.chat.id}/>);
  expect(screen.getAllByText("Sent by scheduled task")).toHaveLength(1);
  const row = view.container.querySelector("[data-scheduled-message]")!;
  expect(row.parentElement?.contains(screen.getByText("Scheduled task triggered."))).toBe(true);
  expect(row.querySelector("time")?.dateTime).toBe(detail.messages[0]!.createdAt);
  detail.messages[1]!.parts = [{ type: "text", text: "Streaming reply grew." }];
  view.rerender(<ChatApp {...props} messages={projectCanonicalTranscript(detail)} sessionId={detail.record.chat.id}/>);
  expect(screen.getAllByText("Sent by scheduled task")).toHaveLength(1);
  detail.messages[0]!.role = "user"; detail.messages[0]!.purpose = "ai_request";
  view.rerender(<ChatApp {...props} messages={projectCanonicalTranscript(detail)} sessionId="chat_manual"/>);
  expect(screen.queryByText("Sent by scheduled task")).toBeNull();
  expect(screen.getByText("Scheduled task triggered.")).toBeTruthy();
});

it("uses the same Pi clock/label/localized date row on the actual Electron input component", () => {
  const detail = nativeScheduledMessageFixture();
  const input = canonicalChatPresentation(detail)[0]!.user!;
  const view = render(<UserMessage message={input} callbacks={{ copyText: vi.fn() }}/>);
  expect(screen.getAllByText("Sent by scheduled task")).toHaveLength(1);
  expect(view.container.querySelector(`[data-message-id="user:${input.id}"] [data-scheduled-message]`)).toBeTruthy();
  cleanup();
  const saved = routineMessageFixture();
  const occurrence = { routine: saved.routine, fire: saved.history[0]! };
  const rows = render(<><RoutineMessageMeta occurrence={occurrence}/><ScheduledMessageMeta timestamp={occurrence.fire.scheduledFor}/></>);
  const metas = rows.container.querySelectorAll("[data-scheduled-message]");
  expect(metas[0]!.innerHTML).toBe(metas[1]!.innerHTML);
});


it.each(["electron", "web", "web-mobile"])("expands the exact long saved native input in %s without duplicating its annotation", surface => {
  const detail = nativeScheduledMessageFixture();
  const text = "Only the safe stored message is available. ".repeat(10);
  detail.messages[0]!.parts = [{ type: "text", text }];
  const view = render(surface === "electron"
    ? <UserMessage message={canonicalChatPresentation(detail)[0]!.user!} callbacks={{ copyText: vi.fn() }}/>
    : <ChatApp mobile={surface === "web-mobile"} busy={false} connected conversations={[]}
        messages={projectCanonicalTranscript(detail)} sessionId={detail.record.chat.id}
        onNewChat={vi.fn()} onSwitchConversation={vi.fn()} onSubmit={vi.fn()}/>);
  const expand = screen.getByRole("button", { name: surface === "electron" ? "Show full message" : "Show more" });
  expect(expand.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(expand);
  expect(screen.getByRole("button", { name: "Show less" }).getAttribute("aria-expanded")).toBe("true");
  expect(view.container.textContent).toContain(text.trim());
  expect(screen.getAllByText("Sent by scheduled task")).toHaveLength(1);
});
