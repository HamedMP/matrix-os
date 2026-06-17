// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AgentSection from "../../desktop/src/renderer/src/features/settings/sections/AgentSection";
import { useConnection } from "../../desktop/src/renderer/src/stores/connection";

describe("AgentSection", () => {
  let api: {
    get: ReturnType<typeof vi.fn>;
    getText: ReturnType<typeof vi.fn>;
    put: ReturnType<typeof vi.fn>;
    putText: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    api = {
      get: vi.fn((path: string) => {
        if (path === "/api/settings/agent") {
          return Promise.resolve({
            kernel: { model: null, effort: null },
            availableModels: [
              { id: "sonnet", label: "Sonnet", tier: "Balanced" },
              { id: "opus", label: "Opus", tier: "Deep" },
            ],
            availableEfforts: ["medium"],
            defaults: { model: "sonnet", effort: "medium" },
          });
        }
        if (path === "/api/agents/credentials/status") {
          return Promise.resolve({});
        }
        return Promise.reject(new Error(`unexpected path ${path}`));
      }),
      getText: vi.fn().mockResolvedValue("# SOUL"),
      put: vi.fn().mockResolvedValue({ ok: true }),
      putText: vi.fn(),
    };
    useConnection.setState({
      status: "signed-in",
      handle: "operator",
      platformHost: "https://platform.test",
      runtimeSlot: "primary",
      api: api as never,
    });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("does not crash when provider status omits agents", async () => {
    render(<AgentSection />);

    await screen.findByText("Coding agents & credentials");
    await waitFor(() => {
      expect(screen.queryByText("Checking provider status...")).toBeNull();
    });
  });

  it("clears the model save timer on unmount", async () => {
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
    const { unmount } = render(<AgentSection />);

    fireEvent.click(await screen.findByRole("button", { name: "Opus" }));
    const saveButtons = screen.getAllByRole("button", { name: /save/i }) as HTMLButtonElement[];
    const enabledSave = saveButtons.find((button) => !button.disabled);
    expect(enabledSave).toBeTruthy();
    fireEvent.click(enabledSave!);

    await waitFor(() => expect(api.put).toHaveBeenCalledWith("/api/settings/agent", { model: "opus", effort: "medium" }));
    await screen.findByText("Saved");

    unmount();

    expect(clearTimeoutSpy).toHaveBeenCalled();
  });
});
