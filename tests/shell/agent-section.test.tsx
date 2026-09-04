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
}));

vi.mock("@matrix-os/ui", () => ({
  AgentsProvidersView: ({
    onOpenTerminal,
    onOpenBrowser,
  }: {
    onOpenTerminal: (sessionId: string) => void;
    onOpenBrowser: (path: string) => void;
  }) => (
    <div>
      <h2>Agents &amp; providers</h2>
      <button onClick={() => onOpenTerminal("provider-login")}>Continue in Terminal</button>
      <button onClick={() => onOpenBrowser("/api/ai/providers/login-attempts/attempt-1/authorize")}>Continue in browser</button>
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
    mutate: vi.fn(),
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
