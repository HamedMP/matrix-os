// @vitest-environment jsdom

import React from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AgentSection from "../../desktop/src/renderer/src/features/settings/sections/AgentSection";
import { useConnection } from "../../desktop/src/renderer/src/stores/connection";

describe("AgentSection", () => {
  beforeEach(() => {
    useConnection.setState({
      status: "signed-in",
      handle: "operator",
      platformHost: "https://platform.test",
      runtimeSlot: "primary",
      api: {
        get: vi.fn((path: string) => {
          if (path === "/api/settings/agent") {
            return Promise.resolve({
              kernel: { model: null, effort: null },
              availableModels: [{ id: "sonnet", label: "Sonnet", tier: "Balanced" }],
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
        put: vi.fn(),
        putText: vi.fn(),
      } as never,
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("does not crash when provider status omits agents", async () => {
    render(<AgentSection />);

    await screen.findByText("Coding agents & credentials");
    await waitFor(() => {
      expect(screen.queryByText("Checking provider status...")).toBeNull();
    });
  });
});
