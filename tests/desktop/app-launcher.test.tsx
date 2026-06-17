// @vitest-environment jsdom

import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AppLauncher from "@desktop/renderer/src/features/embeds/AppLauncher";
import { useConnection } from "@desktop/renderer/src/stores/connection";

vi.mock("@desktop/renderer/src/features/embeds/EmbedHost", () => ({
  default: ({ slug }: { slug: string }) => <div>Embed {slug}</div>,
}));

describe("AppLauncher", () => {
  beforeEach(() => {
    useConnection.setState({
      status: "signed-in",
      handle: "operator",
      platformHost: "https://platform.test",
      runtimeSlot: "primary",
      api: {
        get: vi.fn().mockResolvedValue({
          apps: [
            { slug: "notes", name: 42 },
            { slug: "chat", name: "Chat" },
            { slug: "", name: "Blank" },
            { name: "Missing slug" },
          ],
        }),
      } as never,
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("falls back to slug names and skips invalid app rows", async () => {
    render(<AppLauncher />);

    expect(await screen.findByRole("button", { name: /notes/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /chat/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /blank/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /missing slug/i })).toBeNull();
  });
});
