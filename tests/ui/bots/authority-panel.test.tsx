// @vitest-environment jsdom
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { BotAuthorityView } from "@matrix-os/contracts";
import { BotAuthorityPanel } from "../../../packages/ui/src/chat-agents/bots/BotAuthorityPanel.js";

afterEach(cleanup);
const view: BotAuthorityView = {
  agentId: "bot_research1", revision: 2,
  grants: [{ grantId: "gr_abcdefgh", service: "gmail", accountLabel: "Work", effects: ["read"], audience: "direct", expiresAt: null }],
  connections: [{ service: "gmail", state: "granted" }], routines: [], pendingInteractions: [],
  memory: { items: [{ itemId: "mem_abcdefgh", kind: "preference", scope: "bot", content: "Use concise briefs",
    source: { messageId: "msg_abcdefgh", at: "2026-09-28T12:00:00.000Z" }, confirmed: false, revision: 1 }] },
};

describe("bot authority panel", () => {
  it("shows grants and memory provenance, then confirms only after success", async () => {
    let finish!: () => void;
    const confirm = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    render(<BotAuthorityPanel view={view} onRevoke={vi.fn()} onMemory={confirm} />);
    expect(screen.getByText(/Work · read/)).toBeTruthy();
    expect(screen.getByText("Use concise briefs")).toBeTruthy();
    expect(screen.getByText(/From Chat/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Confirm memory" }));
    expect(screen.getByRole("button", { name: "Confirm memory" })).toBeTruthy();
    finish();
    await waitFor(() => expect(screen.queryByRole("button", { name: "Confirm memory" })).toBeNull());
    expect(confirm).toHaveBeenCalledWith("mem_abcdefgh", "confirm", { baseRevision: 1 });
  });

  it("keeps the grant after a failed revoke and hides provider details", async () => {
    const revoke = vi.fn(async () => { throw new Error("postgres /home/matrix unavailable"); });
    render(<BotAuthorityPanel view={view} onRevoke={revoke} onMemory={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Revoke Work" }));
    await screen.findByRole("alert");
    expect(screen.getByText(/Work · read/)).toBeTruthy();
    expect(screen.getByRole("alert").textContent).not.toMatch(/postgres|\/home/);
  });
});
