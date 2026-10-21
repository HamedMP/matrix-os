// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ChatApp } from "../../shell/src/components/ChatApp";
import type { ChatAgentDraftRequest, StartAgentChat } from "@matrix-os/ui";
import type { ChatComposerDraft } from "../../shell/src/components/chat/useChatComposerDraft";
vi.mock("@clerk/nextjs", () => ({ useOrganization: () => ({ organization: null }), useAuth: () => ({ userId: null, sessionId: null }) }));
vi.mock("../../shell/src/components/chat-provider-onboarding", () => ({ ChatProviderOnboarding: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock("@matrix-os/ui", async original => ({ ...await original<typeof import("@matrix-os/ui")>(),
  ChatAgentsRailSection: ({ onStartChat }: { onStartChat: StartAgentChat }) => <button onClick={() => onStartChat("Private template intent")}>Start test agent</button>,
}));
vi.mock("../../shell/src/components/chat/ChatInput", () => ({ ChatInput: ({ draftRequest, composer }: { draftRequest?: ChatAgentDraftRequest; composer: ChatComposerDraft }) => <>
  <output data-testid="pending-intent">{draftRequest?.text ?? ""}</output>
  <input aria-label="Local draft" value={composer.text} onChange={event => composer.setText(event.target.value)} />
</> }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it("retains local text and pending Agent prefill through same-owner recovery, but never offers them to a new owner", () => {
  vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
  const owner = {}, nextOwner = {};
  const props = { messages: [], busy: false, connected: true, conversations: [], onSubmit: vi.fn(), onNewChat: vi.fn(), onSwitchConversation: vi.fn() };
  const { rerender } = render(<ChatApp {...props} composerIdentity={owner} authorityKey="owner/epoch0" />);
  fireEvent.click(screen.getByRole("button", { name: "Start test agent" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Local draft" }), { target: { value: "Unsent text" } });
  expect(screen.getByTestId("pending-intent").textContent).toBe("Private template intent");
  rerender(<ChatApp {...props} composerIdentity={owner} authorityKey="owner/epoch1" />);
  expect(screen.getByTestId("pending-intent").textContent).toBe("Private template intent");
  expect((screen.getByRole("textbox", { name: "Local draft" }) as HTMLInputElement).value).toBe("Unsent text");
  rerender(<ChatApp {...props} composerIdentity={nextOwner} authorityKey="next/epoch0" />);
  expect(screen.getByTestId("pending-intent").textContent).toBe("");
  expect((screen.getByRole("textbox", { name: "Local draft" }) as HTMLInputElement).value).toBe("");
});
