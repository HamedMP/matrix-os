// @vitest-environment jsdom

import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CollaborationDirectApi } from "@matrix-os/ui";
import {
  groupTeamTerminals,
  listTeamTerminals,
  teamRowKey,
  teamScopeFromKey,
  teamSessionName,
} from "@desktop/renderer/src/features/terminal-window/team/team-terminals";
import { clearTeamSessions, teamSession, updateTeamSession } from "@desktop/renderer/src/features/terminal-window/team/team-session-store";
import { createTeamTerminalSocket } from "@desktop/renderer/src/features/terminal-window/team/team-terminal-socket";
import { TeamSpaces } from "@desktop/renderer/src/features/terminal-window/team/TeamSpaces";
import { lastSubmitted, teamPaneNotice } from "@desktop/renderer/src/features/terminal-window/team/TeamPaneBar";

const scopeA = "10000000-0000-4000-8000-00000000000a";
const scopeB = "10000000-0000-4000-8000-00000000000b";
const scopeC = "10000000-0000-4000-8000-00000000000c";
const runtimeId = "vps:11111111-1111-4111-8111-111111111111";
const incarnation = `terminal-${"a".repeat(32)}`;

function projection(scopeId: string, role: "editor" | "viewer", name = "api-server") {
  return {
    scopeId, incarnation, terminalName: name, computerLabel: "team-dev-1",
    owner: { actorId: "user_nima", displayName: "Nima Naderi" }, role, status: "active", inputMode: "shared",
    size: { cols: 120, rows: 40 },
  };
}

const item = (scopeId: string, status: string, extra: Record<string, unknown> = {}) => ({
  scopeId, runtimeId, ownerId: "user_nima", kind: "terminal", authorityGeneration: 1, status, organizationId: "org_team", ...extra,
});

afterEach(() => { cleanup(); clearTeamSessions(); vi.useRealTimers(); });

describe("Team terminals listing (spec 2710 J2)", () => {
  it("lists only shared terminals, hydrated from the owner's computer, grouped as \"Nima's team-dev-1\"", async () => {
    const api = {
      getDiscovery: vi.fn(async (path: string) => path.startsWith("/api/collaboration/inbox")
        ? { items: [item(scopeB, "organization_pending", { grantId: "20000000-0000-4000-8000-000000000001" })] }
        : { items: [item(scopeA, "accepted"), item(scopeC, "accepted"), { ...item("10000000-0000-4000-8000-0000000000dd", "accepted"), kind: "chat" }] }),
      get: vi.fn(async (path: string) => {
        if (path.includes(scopeC)) throw new Error("host_offline");
        return projection(scopeA, "editor");
      }),
      post: vi.fn(),
    };
    const terminals = await listTeamTerminals(api);
    expect(terminals.map((terminal) => [terminal.scopeId, terminal.kind])).toEqual([
      [scopeB, "pending"], [scopeA, "ready"], [scopeC, "offline"],
    ]);
    expect(api.get).not.toHaveBeenCalledWith(expect.stringContaining("dd/terminal"));
    const [group] = groupTeamTerminals(terminals);
    expect(group!.name).toBe("Nima's team-dev-1");
  });

  it("round-trips a Team row key and refuses anything else", () => {
    expect(teamScopeFromKey(teamRowKey(scopeA))).toBe(scopeA);
    expect(teamScopeFromKey(`computer:primary|${scopeA}`)).toBeNull();
    expect(teamScopeFromKey("team|../../etc")).toBeNull();
  });
});

describe("Team section (spec 2710 J2)", () => {
  it("shows each terminal with this person's role, and opens a pending share by accepting it first", async () => {
    const onOpen = vi.fn();
    const onAccept = vi.fn(async () => true);
    render(<TeamSpaces selectedKey={null} onOpen={onOpen} onAccept={onAccept} onRetry={vi.fn()} state={{ status: "ready", terminals: [
      { kind: "ready", scopeId: scopeA, ownerId: "user_nima", runtimeId, projection: projection(scopeA, "viewer") as never },
      { kind: "pending", scopeId: scopeB, ownerId: "user_nima", runtimeId, grantId: "20000000-0000-4000-8000-000000000001" },
    ] }} />);
    expect(screen.getByRole("region", { name: "Team" })).toBeTruthy();
    expect(screen.getByRole("list", { name: "Nima's team-dev-1" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /api-server.*Viewer/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Shared terminal/ }));
    await waitFor(() => expect(onOpen).toHaveBeenCalledWith(teamRowKey(scopeB)));
    expect(onAccept).toHaveBeenCalledWith(expect.objectContaining({ scopeId: scopeB }));
  });

  it("says where shared terminals will appear when there are none", () => {
    render(<TeamSpaces selectedKey={null} onOpen={vi.fn()} onAccept={vi.fn()} onRetry={vi.fn()} state={{ status: "ready", terminals: [] }} />);
    expect(screen.getByText("Terminals teammates share with you appear here.")).toBeTruthy();
  });
});

function streamHarness() {
  let handlers: Record<string, (frame?: unknown) => void> = {};
  const sent: Array<{ type: string; data?: string }> = [];
  const stop = vi.fn();
  const api = { direct: { subscribeTerminal: vi.fn((_scope: string, next: typeof handlers) => { handlers = next; return stop; }) } } as unknown as CollaborationDirectApi;
  const events = {
    onState: vi.fn(), onOutput: vi.fn(), onGap: vi.fn(), onExit: vi.fn(),
    onCanonicalSize: vi.fn(), onOwnershipChange: vi.fn(),
  };
  const ready = () => {
    handlers.onReady!({ connectionId: "connection_1", incarnation });
    handlers.onSender!((action: { type: string; data?: string }) => { sent.push(action); return true; });
  };
  return { api, events, sent, stop, ready, handlers: () => handlers };
}

describe("Shared pane socket (spec 2710 J3-J6)", () => {
  it("renders at the terminal's own size and sends coalesced keystrokes as shared input", async () => {
    vi.useFakeTimers();
    updateTeamSession(scopeA, { projection: projection(scopeA, "editor") as never });
    const harness = streamHarness();
    const socket = createTeamTerminalSocket(() => harness.api, teamSessionName(scopeA), harness.events);
    socket.connect();
    expect(harness.events.onCanonicalSize).toHaveBeenCalledWith({ cols: 120, rows: 40 });
    expect(harness.events.onOwnershipChange).toHaveBeenCalledWith("writer");
    harness.ready();
    socket.sendInput("ls");
    socket.sendInput(" -la\r");
    await act(async () => { await vi.advanceTimersByTimeAsync(20); });
    expect(harness.sent).toEqual([expect.objectContaining({ type: "input_shared", data: "ls -la\r" })]);
    harness.handlers().onOutput!({ data: "total 0", sequence: "3" });
    expect(harness.events.onOutput).toHaveBeenCalledWith("total 0", 3);
    socket.dispose();
    expect(harness.stop).toHaveBeenCalled();
  });

  it("never sends a viewer's keystrokes and turns read-only when the owner refuses input", async () => {
    vi.useFakeTimers();
    updateTeamSession(scopeA, { projection: projection(scopeA, "viewer") as never });
    const harness = streamHarness();
    const socket = createTeamTerminalSocket(() => harness.api, teamSessionName(scopeA), harness.events);
    socket.connect();
    expect(harness.events.onOwnershipChange).toHaveBeenCalledWith("observer");
    harness.ready();
    socket.sendInput("rm -rf ~\r");
    await act(async () => { await vi.advanceTimersByTimeAsync(20); });
    expect(harness.sent).toEqual([]);
    harness.handlers().onInputRejected!({ code: "forbidden" });
    expect(teamSession(scopeA)?.rejected?.code).toBe("forbidden");
  });

  it("shows that access ended when the owner revokes it or stops sharing", () => {
    updateTeamSession(scopeA, { projection: projection(scopeA, "editor") as never });
    const harness = streamHarness();
    const socket = createTeamTerminalSocket(() => harness.api, teamSessionName(scopeA), harness.events);
    socket.connect();
    harness.ready();
    harness.handlers().onUnavailable!();
    expect(harness.events.onState).toHaveBeenLastCalledWith("ended");
    expect(teamPaneNotice(teamSession(scopeA), Date.now())).toBe("You no longer have access, or the terminal ended.");
  });
});

describe("Shared pane header text (spec 2710 who-typed-what)", () => {
  it("names who pressed Enter last and says when the owner has control", () => {
    const now = Date.parse("2026-11-24T10:00:10.000Z");
    const state = { presence: {
      inputMode: "owner" as const,
      participants: [{ actorId: "user_yuhan", displayName: "Yuhan", role: "editor" as const, connections: 1 }],
      marks: [{ actorId: "user_yuhan", at: "2026-11-24T10:00:05.000Z", outputSeq: "4", bytes: 6, enter: true }],
    } };
    expect(lastSubmitted(state, now)).toBe("Yuhan pressed Enter · 5s ago");
    expect(teamPaneNotice(state, now)).toBe("The owner has control.");
    expect(teamPaneNotice({ ...state, rejected: { code: "input_paused", at: now - 1_000 } }, now)).toBe("The owner has control. Your typing is paused.");
  });
});
