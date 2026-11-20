// @vitest-environment jsdom
import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

// Outcome: in self-hosted mode the root layout renders no ClerkProvider, so
// opening Chat must not call Clerk's useAuth. Fault detected: any Chat render
// path that reaches Clerk directly crashes the whole shell (ENG-514).
// The flag is set before any shell module loads, exactly as the root layout's
// data-matrix-self-hosted attribute is present before the client bundle runs.
vi.hoisted(() => {
  document.documentElement.dataset.matrixSelfHosted = "1";
});

vi.mock("@clerk/nextjs", () => {
  const missingProvider = () => {
    throw new Error("@clerk/react: useAuth can only be used within the <ClerkProvider /> component.");
  };
  return { useAuth: missingProvider, useUser: missingProvider, useOrganization: missingProvider };
});
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/", useSearchParams: () => new URLSearchParams(),
}));
vi.mock("../../shell/src/components/chat-provider-onboarding", () => ({ ChatProviderOnboarding: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock("../../shell/src/components/chat/ChatInput", () => ({ ChatInput: () => null }));
vi.mock("@matrix-os/ui", async original => ({ ...await original<typeof import("@matrix-os/ui")>(),
  useBotConversationSummaries: () => ({ conversations: [], unresolvedChatIds: [], loading: false, error: null }),
  ChatAgentsRailSection: () => null,
}));

import { ChatApp } from "../../shell/src/components/ChatApp";
import { CanonicalRoutineActionMessage } from "../../shell/src/components/chat/CanonicalRoutineActionMessage";
import { OrganizationStateProvider } from "../../shell/src/lib/collaboration-organization-state";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function selfHostedChat(props: Partial<React.ComponentProps<typeof ChatApp>> = {}) {
  // The self-hosted root layout provides exactly this organization state.
  return <OrganizationStateProvider value={{ status: "none", organizationId: null }}>
    <ChatApp messages={[]} busy={false} connected conversations={[]} onNewChat={vi.fn()}
      onSwitchConversation={vi.fn()} onSubmit={vi.fn()} {...props} />
  </OrganizationStateProvider>;
}

it("opens the Chat rail and lists the owner's projects without ClerkProvider", async () => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("fetch", vi.fn(async (url: string) => url.includes("/api/workspace/projects")
    ? Response.json({ projects: [{ id: "proj_home", slug: "home", name: "Home lab" }] })
    : Response.json({})));
  render(selfHostedChat());
  expect(await screen.findByRole("button", { name: "Expand Home lab chats" })).toBeTruthy();
});

it("opens a shared Chat view without ClerkProvider and explains that sharing is unavailable", () => {
  render(selfHostedChat({ collaborationView: { kind: "chat", scopeId: "10000000-0000-4000-8000-000000000001" } }));
  expect(screen.getByRole("alert").textContent).toContain("Organization sharing is no longer available");
});

it("renders a routine action confirmation in a Chat message without ClerkProvider", () => {
  vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
  expect(() => render(<CanonicalRoutineActionMessage challengeId="rac_10000000000000000000000000" />)).not.toThrow();
});
