// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import SystemSection from "../../desktop/src/renderer/src/features/settings/sections/SystemSection";
import { useConnection } from "../../desktop/src/renderer/src/stores/connection";

function makeApi() {
  return {
    baseUrl: "https://app.matrix-os.com",
    get: vi.fn(async (path: string) => {
      if (path === "/api/system/info") {
        return { version: "0.1.0", updateChannel: "stable", release: { version: "v2026.08.20", channel: "stable" } };
      }
      if (path === "/api/system/update?channel=stable") {
        return { channel: "stable", latest: { version: "v2026.08.28", channel: "stable" }, updateAvailable: true };
      }
      if (path === "/api/system/releases?channel=stable") {
        return {
          channel: "stable",
          generatedAt: "2026-08-28T00:00:00.000Z",
          releases: [
            { version: "v2026.08.28", channel: "stable", gitCommit: "0123456789abcdef", changelog: "Bug fixes" },
            { version: "v2026.08.10", channel: "stable", gitCommit: "fedcba9876543210", changelog: "Earlier release" },
          ],
        };
      }
      throw new Error(`Unexpected GET ${path}`);
    }),
    post: vi.fn(async () => ({ ok: true, status: "started" })),
    getText: vi.fn(),
    getBlob: vi.fn(),
    patch: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
    putText: vi.fn(),
  };
}

describe("desktop system updates", () => {
  beforeEach(() => {
    useConnection.setState({ api: makeApi() as never });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("loads release channels and available versions", async () => {
    render(<SystemSection />);

    await waitFor(() => expect(screen.getAllByText("v2026.08.28").length).toBeGreaterThan(0));
    expect(screen.getByLabelText("Release channel")).not.toBeNull();
    expect(screen.getByText("Build ID 0123456789ab")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Downgrade to v2026.08.10" })).not.toBeNull();
  });

  it("starts an upgrade for a selected release version", async () => {
    const api = makeApi();
    useConnection.setState({ api: api as never });
    render(<SystemSection />);

    await waitFor(() => expect(screen.getAllByText("v2026.08.28").length).toBeGreaterThan(0));
    fireEvent.click(screen.getByRole("button", { name: "Upgrade to v2026.08.28" }));

    await waitFor(() => expect(api.post).toHaveBeenCalledWith("/api/system/update", { version: "v2026.08.28" }, expect.anything()));
    expect(screen.getByRole("status", { name: /Installing v2026\.08\.28/i })).not.toBeNull();
  });
});
