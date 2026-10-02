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
    expect(screen.getByText(/Work · Read/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Memory/ }));
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
    expect(screen.getByText(/Work · Read/)).toBeTruthy();
    expect(screen.getByRole("alert").textContent).not.toMatch(/postgres|\/home/);
  });

  it("stops showing granted access after the last grant is revoked", async () => {
    render(<BotAuthorityPanel view={view} onRevoke={vi.fn(async () => undefined)} onMemory={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Revoke Work" }));
    await waitFor(() => expect(screen.queryByText(/Work · Read/)).toBeNull());
    expect(screen.queryByText("granted")).toBeNull();
    expect(screen.getByText("Connected · no access")).toBeTruthy();
  });
});

it("keeps memory visible while forgetting is pending and when it fails", async () => {
  let reject!: (error: Error) => void;
  const memory = vi.fn(() => new Promise<void>((_, fail) => { reject = fail; }));
  render(<BotAuthorityPanel view={view} onRevoke={vi.fn()} onMemory={memory} />);
  fireEvent.click(screen.getByRole("button", { name: /Memory/ }));
  fireEvent.click(screen.getByRole("button", { name: "Forget memory" }));
  expect(screen.getByText("Use concise briefs")).toBeTruthy();
  expect((screen.getByRole("button", { name: "Forget memory" }) as HTMLButtonElement).disabled).toBe(true);
  reject(new Error("provider secret /private/home"));
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect(screen.getByText("Use concise briefs")).toBeTruthy();
  expect(screen.getByRole("alert").textContent).not.toMatch(/provider|private/);
});

it("keeps cached settings read-only after the latest authority read fails", () => {
  render(<BotAuthorityPanel view={view} actionsAvailable={false} onRevoke={vi.fn()} onMemory={vi.fn()} />);
  expect((screen.getByRole("button", { name: "Revoke Work" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: /Memory/ }));
  expect((screen.getByRole("button", { name: "Forget memory" }) as HTMLButtonElement).disabled).toBe(true);
});

it("explains how to populate each empty section without implying automatic access", () => {
  render(<BotAuthorityPanel view={{ ...view, grants: [], connections: [], routines: [], memory: { items: [] } }} onRevoke={vi.fn()} onMemory={vi.fn()} />);
  expect(screen.getByRole("heading", { name: "No connections yet" })).toBeTruthy();
  expect(screen.getByText("Ask your bot to use a service. It will request access when needed.")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /Memory/ }));
  expect(screen.getByRole("heading", { name: "Nothing remembered yet" })).toBeTruthy();
  expect(screen.getByText('Try saying "Remember that I prefer short summaries."')).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /Routines/ }));
  expect(screen.getByRole("heading", { name: "No routines yet" })).toBeTruthy();
  expect(screen.getByText("Scheduling routines is not available yet.")).toBeTruthy();
});
