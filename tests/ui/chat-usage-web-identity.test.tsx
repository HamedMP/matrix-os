// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { WebChatUsageSettings } from "../../shell/src/components/settings/sections/ChatUsageSettings.js";
const state = vi.hoisted(() => ({ userId: "first-owner", sessionId: "session-one", selfHosted: false, clients: [] as Array<{ isIdentityCurrent: () => boolean }> }));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ userId: state.userId, sessionId: state.sessionId, isLoaded: true }) }));
vi.mock("../../shell/src/lib/self-host-mode", () => ({ isSelfHostedRuntime: () => state.selfHosted }));
vi.mock("../../shell/src/lib/chat-usage-transport", () => ({ createWebChatUsageClient: (options: { isIdentityCurrent: () => boolean }) => { state.clients.push(options); return {}; } }));
vi.mock("@matrix-os/ui", () => ({ ChatUsagePanel: ({ identityKey }: { identityKey: string }) => <span data-testid="identity">{identityKey}</span> }));
afterEach(() => { cleanup(); state.clients.length = 0; state.userId = "first-owner"; state.sessionId = "session-one"; state.selfHosted = false; });
it("binds mounted requests to account, session and selected computer across account changes", async () => {
  const view = render(<WebChatUsageSettings />);
  expect(screen.getByTestId("identity")).toHaveTextContent("first-owner");
  const previous = state.clients[0]!;
  state.userId = "second-owner"; state.sessionId = "session-two";
  view.rerender(<WebChatUsageSettings />);
  await waitFor(() => expect(previous.isIdentityCurrent()).toBe(false));
  expect(screen.getByTestId("identity")).toHaveTextContent("second-owner");
});
it("does not call Clerk hooks outside its provider in self-hosted mode", () => {
  state.selfHosted = true;
  render(<WebChatUsageSettings />);
  expect(screen.queryByTestId("identity")).toBeNull();
  expect(screen.getByText(/signed-in Matrix account/)).toBeVisible();
});
