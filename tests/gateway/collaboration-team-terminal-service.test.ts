import { describe, expect, it, vi } from "vitest";
import { CollaborationTeamTerminalPresenceFrameSchema, TeamTerminalOwnerEntrySchema } from "@matrix-os/contracts";
import { TeamTerminalInputModes } from "../../packages/gateway/src/collaboration/team-terminal-input-mode.js";
import { TeamTerminalService } from "../../packages/gateway/src/collaboration/team-terminal-service.js";
import type { CollaborationTerminalConnectionObserver } from "../../packages/gateway/src/collaboration/terminal-events.js";
import { createTerminalEventHub } from "../../packages/gateway/src/terminal-agent/events.js";

const scopeId = "10000000-0000-4000-8000-000000000001";
const workspaceId = `tws_${"3".repeat(32)}`;
const tabId = `tt_${"4".repeat(32)}`;
const incarnation = `terminal-${"a".repeat(32)}`;

function setup() {
  let observer: CollaborationTerminalConnectionObserver | undefined;
  const subscribed = new Set<string>();
  const sent: string[] = [];
  let sequence = 7;
  const registry = {
    observe: vi.fn((next: CollaborationTerminalConnectionObserver | undefined) => { observer = next; }),
    subscribePresence: vi.fn((connectionId: string) => { subscribed.add(connectionId); return true; }),
    liveTerminal: vi.fn((id: string) => id === scopeId
      ? { terminalId: `${workspaceId}:${tabId}`, incarnation, ownerId: "user_owner", sequence } : null),
    scopeForTerminal: vi.fn((terminalId: string) => terminalId === `${workspaceId}:${tabId}` ? scopeId : null),
    sendPresence: vi.fn((_scope: string, value: string) => { sent.push(value); }),
  };
  const inputModes = new TeamTerminalInputModes();
  const names: Record<string, string> = { user_owner: "Nima", user_yuhan: "Yuhan", user_sam: "Sam" };
  const service = new TeamTerminalService({
    registry, inputModes, minIntervalMs: 0,
    resolveParticipant: async (actorId) => ({ actorId, displayName: names[actorId] ?? "Someone" }),
  });
  return {
    service, registry, inputModes, sent, subscribed,
    observer: () => observer!,
    setSequence: (value: number) => { sequence = value; },
    lastFrame: () => CollaborationTeamTerminalPresenceFrameSchema.parse(JSON.parse(sent.at(-1)!)),
  };
}

describe("TeamTerminalService (spec 2710)", () => {
  it("tells subscribed collaborators who is watching, with the owner named first", async () => {
    const fixture = setup();
    fixture.observer().joined({ scopeId, connectionId: "c1", actorId: "user_yuhan", role: "editor", ownerId: "user_owner" });
    fixture.observer().joined({ scopeId, connectionId: "c2", actorId: "user_sam", role: "viewer", ownerId: "user_owner" });
    await vi.waitFor(() => expect(fixture.service.presence.state(scopeId, "shared").participants).toHaveLength(3));
    expect(fixture.service.subscribe(scopeId, "c1")).toBe(true);
    expect(fixture.lastFrame().participants.map((p) => [p.displayName, p.role])).toEqual([
      ["Nima", "owner"], ["Yuhan", "editor"], ["Sam", "viewer"],
    ]);
  });

  it("attributes shared and owner input at the current output position and reports the input mode", async () => {
    const fixture = setup();
    fixture.observer().joined({ scopeId, connectionId: "c1", actorId: "user_yuhan", role: "editor", ownerId: "user_owner" });
    await vi.waitFor(() => expect(fixture.service.presence.has(scopeId)).toBe(true));
    fixture.service.subscribe(scopeId, "c1");
    fixture.service.noteSharedInput(scopeId, "user_yuhan", "npm test\r");
    fixture.setSequence(9);
    fixture.service.noteOwnerInput({ workspaceId, tabId }, "y", "user_owner");
    fixture.inputModes.set(scopeId, incarnation, "owner");
    fixture.service.inputModeChanged(scopeId);
    const frame = fixture.lastFrame();
    expect(frame.inputMode).toBe("owner");
    expect(frame.marks.map((mark) => [mark.actorId, mark.outputSeq, mark.enter])).toEqual([
      ["user_yuhan", "7", true], ["user_owner", "9", false],
    ]);
    expect(fixture.sent.join("")).not.toContain("npm test");
  });

  it("ignores owner typing in a tab nobody is watching", () => {
    const fixture = setup();
    fixture.service.noteOwnerInput({ workspaceId: `tws_${"9".repeat(32)}`, tabId }, "ls\r");
    expect(fixture.sent).toEqual([]);
  });

  it("feeds the owner's events socket and drops a tab when its last watcher leaves", async () => {
    const fixture = setup();
    const hub = createTerminalEventHub({ runtime: { listWorkspaces: async () => [] }, status: { get: async () => undefined, list: async () => new Map() } as never, autoStart: false });
    const frames: unknown[] = [];
    hub.subscribe({ send: (frame) => frames.push(frame), close: vi.fn() });
    await hub.tick();
    const stop = fixture.service.onOwnerEntries((entries) => hub.publishTeam(entries));
    fixture.observer().joined({ scopeId, connectionId: "c1", actorId: "user_yuhan", role: "editor", ownerId: "user_owner" });
    await vi.waitFor(() => expect(frames.some((frame) => (frame as { type: string }).type === "team")).toBe(true));
    const team = frames.filter((frame) => (frame as { type: string }).type === "team").at(-1) as { tabs: Record<string, unknown> };
    const entry = TeamTerminalOwnerEntrySchema.parse(team.tabs[`${workspaceId}:${tabId}`]);
    expect(entry.participants.map((p) => p.actorId)).toEqual(["user_owner", "user_yuhan"]);
    fixture.observer().left(scopeId, "c1");
    const last = frames.filter((frame) => (frame as { type: string }).type === "team").at(-1) as { tabs: Record<string, unknown> };
    expect(last.tabs).toEqual({});
    stop();
    fixture.service.close();
    expect(fixture.registry.observe).toHaveBeenLastCalledWith(undefined);
    hub.shutdown();
  });

  it("bounds owner feed listeners", () => {
    const fixture = setup();
    for (let index = 0; index < 8; index += 1) fixture.service.onOwnerEntries(vi.fn());
    expect(() => fixture.service.onOwnerEntries(vi.fn())).toThrow();
  });
});
