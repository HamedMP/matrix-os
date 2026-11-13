// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CanonicalChatWorkspace } from "@desktop/renderer/src/features/chat/CanonicalChatWorkspace";
import { useBoard } from "@desktop/renderer/src/stores/board";
import { useConnection } from "@desktop/renderer/src/stores/connection";
import { ChatApp } from "../../shell/src/components/ChatApp";
import { projectCanonicalTranscript } from "../../shell/src/lib/canonical-chat-terminal-notices";
import { createCanonicalChatFixture } from "../contracts/fixtures/canonical-chat";
import { createCanonicalChatWorkspaceClient } from "../desktop/canonical-chat-workspace-test-utils";

vi.mock("../../shell/src/components/chat/web-projects", async (original) => ({
  ...await original<typeof import("../../shell/src/components/chat/web-projects")>(),
  useWebProjects: () => ({ identity: "owner", projects: [], loading: false, error: false, retry: () => {} }),
}));
vi.mock("@clerk/nextjs", async (original) => ({
  ...await original<typeof import("@clerk/nextjs")>(),
  useOrganization: () => ({ organization: null }),
  useAuth: () => ({ userId: null, sessionId: null }),
}));

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  useBoard.setState(useBoard.getInitialState(), true);
  useConnection.setState(useConnection.getInitialState(), true);
  window.operator = { invoke: vi.fn(async () => ({ ok: true })), on: vi.fn(() => () => undefined) };
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); window.localStorage.clear(); });

it.each(["Web", "Electron"] as const)("keeps %s approval Review inside the transcript viewport", async (surface) => {
  const { snapshot, providerCatalog } = createCanonicalChatFixture("approval_required");
  const run = snapshot.runs[0]!;
  const approvalId = "approval_review_scroll";
  const detail = {
    ...snapshot,
    activities: [{
      id: "activity_review_scroll", chatId: snapshot.chat.id, runId: run.id,
      occurredAt: run.updatedAt, type: "approval.requested" as const, approvalId,
      title: "Run a command · “git status”", risk: "high" as const,
      allowedDecisions: ["approve" as const, "decline" as const],
    }],
  };
  if (surface === "Web") {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(providerCatalog)));
    render(<ChatApp messages={projectCanonicalTranscript(detail)} sessionId={snapshot.chat.id}
      busy connected conversations={[]} onNewChat={vi.fn()} onSwitchConversation={vi.fn()}
      onSubmit={vi.fn()} onSubmitApproval={vi.fn(async () => true)} />);
  } else {
    const client = createCanonicalChatWorkspaceClient();
    const record = {
      chat: { ...snapshot.chat, providerBinding: undefined, activeRun: undefined, project: undefined },
      projectId: "matrix-os", providerBinding: snapshot.chat.providerBinding, activeRun: snapshot.chat.activeRun,
    };
    vi.mocked(client.list).mockResolvedValue({ items: [record] });
    vi.mocked(client.getDetail).mockResolvedValue({ ...detail, record });
    render(<CanonicalChatWorkspace client={client} projectId="matrix-os" projectLabel="Matrix OS"
      initialChatId={snapshot.chat.id} initialView="conversation" active catalog={providerCatalog} />);
  }

  const review = await screen.findByRole("button", { name: "Review", exact: true });
  const anchor = document.getElementById(`tool-approval-${approvalId}`)!;
  expect(anchor).toBeTruthy();
  // These are the real renderer-owned scroll elements, not a substitute scroller.
  const viewport = surface === "Electron"
    ? anchor.closest<HTMLElement>('[data-slot="message-scroller-viewport"]')!
    : screen.getByRole("log").firstElementChild as HTMLElement;
  expect(viewport.contains(anchor)).toBe(true);
  Object.defineProperties(viewport, {
    clientHeight: { configurable: true, value: 300 },
    scrollHeight: { configurable: true, value: 1500 },
  });
  viewport.scrollTop = 100;
  vi.spyOn(viewport, "getBoundingClientRect").mockReturnValue({ top: 40, height: 300 } as DOMRect);
  vi.spyOn(anchor, "getBoundingClientRect").mockReturnValue({ top: 740, height: 100 } as DOMRect);
  const boundedScroll = vi.fn();
  Object.defineProperty(viewport, "scrollTo", { configurable: true, value: boundedScroll });
  const unboundedScroll = vi.fn();
  Object.defineProperty(anchor, "scrollIntoView", { configurable: true, value: unboundedScroll });
  const ancestors: HTMLElement[] = [];
  for (let ancestor = viewport.parentElement; ancestor; ancestor = ancestor.parentElement) ancestors.push(ancestor);

  fireEvent.click(review);

  // Centering requires top 100 + (740 - 40) - (300 - 100)/2 = 700.
  // Native scrollIntoView can scroll all ancestors, including the composer host.
  expect(boundedScroll).toHaveBeenCalledWith(expect.objectContaining({ top: 700 }));
  expect(unboundedScroll).not.toHaveBeenCalled();
  expect(ancestors.every(ancestor => ancestor.scrollTop === 0)).toBe(true);
});
