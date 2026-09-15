// @vitest-environment jsdom

import React from "react";
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSection } from "../../shell/src/components/settings/sections/AgentSection.js";
import { IdentityPersonalitySection } from "../../shell/src/components/settings/sections/IdentityPersonalitySection.js";

const providerControllerState = vi.hoisted(() => ({
  snapshot: {} as unknown,
  error: null as string | null,
  mutate: vi.fn(),
}));

vi.mock("@matrix-os/ui", () => ({
  AgentsProvidersView: ({
    onOpenTerminal,
    onOpenBrowser,
    onMutate,
  }: {
    onOpenTerminal: (sessionId: string) => void;
    onOpenBrowser: (path: string) => void;
    onMutate: (intent: unknown) => Promise<boolean>;
  }) => (
    <div>
      <h2>Agents &amp; providers</h2>
      <button onClick={() => onOpenTerminal("provider-login")}>Continue in Terminal</button>
      <button onClick={() => onOpenBrowser("/api/ai/providers/login-attempts/attempt-1/authorize")}>Continue in browser</button>
      <button onClick={() => void onMutate({ type: "start_login", harnessInstanceId: "claude", accountId: null, method: "terminal" })}>Sign in</button>
    </div>
  ),
  useProviderSettingsController: () => ({
    snapshot: providerControllerState.snapshot,
    selectedHarnessId: null,
    connectionAttempt: null,
    busy: false,
    error: providerControllerState.error,
    onSelectHarness: vi.fn(),
    refresh: vi.fn(),
    mutate: providerControllerState.mutate,
  }),
  ProviderSettingsTransportError: class ProviderSettingsTransportError extends Error {
    code: string;
    constructor(code: string) {
      super("Provider settings are unavailable.");
      this.code = code;
    }
  },
}));

afterEach(() => {
  providerControllerState.snapshot = {};
  providerControllerState.error = null;
  providerControllerState.mutate.mockReset();
  window.history.replaceState({}, "", "/");
  vi.unstubAllGlobals();
});

describe("Canvas settings sections", () => {
  it("renders the shared provider adapter separately from identity and personality", () => {
    vi.stubGlobal("fetch", vi.fn());
    const onOpenTerminal = vi.fn();
    render(<AgentSection onOpenTerminal={onOpenTerminal} />);

    const heading = screen.getByRole("heading", { name: "Agents & providers" });
    expect(heading).toBeVisible();
    expect(heading.closest("[data-provider-settings-adapter='shared']")).toBeTruthy();
    expect(screen.queryByText("SOUL (Personality)")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Continue in Terminal" }));
    expect(onOpenTerminal).toHaveBeenCalledWith("provider-login");
  });

  it("shows a safe unavailable state when the first provider read fails", () => {
    providerControllerState.snapshot = null;
    providerControllerState.error = "Provider settings are unavailable.";

    render(<AgentSection />);

    expect(screen.getByRole("alert")).toHaveTextContent("Provider settings are unavailable");
    expect(screen.queryByText(/Anthropic|secret|private/i)).toBeNull();
  });

  it("opens the newly returned terminal action from Sign in once, without an effect", async () => {
    const onOpenTerminal = vi.fn();
    providerControllerState.mutate.mockImplementation(async (_intent, options) => {
      options.onLoginAction({ kind: "open_terminal", terminalSessionId: "provider-login" });
      return true;
    });
    const view = render(<AgentSection onOpenTerminal={onOpenTerminal} />);
    expect(onOpenTerminal).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(onOpenTerminal).toHaveBeenCalledExactlyOnceWith("provider-login"));
    view.rerender(<AgentSection onOpenTerminal={onOpenTerminal} />);
    expect(onOpenTerminal).toHaveBeenCalledTimes(1);
  });

  it("does not open a delayed login action after switching computers", async () => {
    let deliver: (action: unknown) => void = () => {};
    providerControllerState.mutate.mockImplementation(async (_intent, options) => {
      deliver = options.onLoginAction;
      return true;
    });
    const onOpenTerminal = vi.fn();
    render(<AgentSection onOpenTerminal={onOpenTerminal} />);
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    window.history.replaceState({}, "", "/vm/other?runtime=other");
    deliver({ kind: "open_terminal", terminalSessionId: "provider-login" });
    expect(onOpenTerminal).not.toHaveBeenCalled();
  });

  it("persists SOUL to its owner-controlled file", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => (
      String(input).endsWith("/files/system/soul.md")
        ? new Response("Original soul")
        : Response.json({ displayName: "Matrix" })
    ));
    vi.stubGlobal("fetch", fetcher);
    render(<IdentityPersonalitySection />);

    expect(screen.getByRole("heading", { name: "Identity & personality" })).toBeVisible();

    expect(await screen.findByText("Original soul")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Markdown editor" }), {
      target: { value: "Updated soul" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(fetcher).toHaveBeenCalledWith(
      expect.stringContaining("/files/system/soul.md"),
      expect.objectContaining({ method: "PUT", body: "Updated soul" }),
    ));
    expect(fetcher.mock.calls.some((call) => String(call[0]).includes("/api/bridge/data"))).toBe(false);
  });
});
