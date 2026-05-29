import React from "react";
import { renderToString } from "ink";
import { describe, expect, it, vi } from "vitest";
import { createAccountProfileAdapter } from "../../src/cli/tui/account.js";
import { AccountViews } from "../../src/cli/tui/views/AccountViews.js";

describe("account/profile TUI flows", () => {
  it("loads profile and auth state through injected CLI adapters", async () => {
    const adapter = createAccountProfileAdapter({
      resolveProfile: vi.fn(async () => ({ name: "cloud", gatewayUrl: "https://app.matrix-os.com", platformUrl: "https://app.matrix-os.com" })),
      loadAuth: vi.fn(async () => ({ authenticated: true, expired: false, handle: "nim" })),
    });

    await expect(adapter.load()).resolves.toEqual(expect.objectContaining({ profileName: "cloud", authenticated: true, handle: "nim" }));
  });

  it("renders login/logout/profile actions without leaking token details", () => {
    const output = renderToString(<AccountViews state={{ profileName: "cloud", authenticated: true, handle: "nim" }} noColor />);

    expect(output).toContain("Profile cloud");
    expect(output).toContain("nim");
    expect(output).toContain("Logout");
    expect(output).not.toContain("token");
  });
});
