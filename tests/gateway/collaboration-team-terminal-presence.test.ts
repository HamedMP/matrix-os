import { afterEach, describe, expect, it, vi } from "vitest";
import { CollaborationTeamTerminalPresenceStateSchema } from "@matrix-os/contracts";
import { TeamTerminalPresence, describeTerminalInput } from "../../packages/gateway/src/collaboration/team-terminal-presence.js";

const scopeId = "10000000-0000-4000-8000-000000000001";
const owner = { ownerId: "user_owner" };

describe("TeamTerminalPresence (spec 2710 presence and attribution)", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("lists the owner and each watcher once, counting their sockets", () => {
    const presence = new TeamTerminalPresence({ onChange: vi.fn(), now: () => 0 });
    presence.join(scopeId, "c1", { actorId: "user_yuhan", displayName: "Yuhan", role: "editor", ...owner });
    presence.join(scopeId, "c2", { actorId: "user_yuhan", displayName: "Yuhan", role: "editor", ...owner });
    presence.join(scopeId, "c3", { actorId: "user_sam", displayName: "Sam", role: "viewer", ...owner });
    const state = CollaborationTeamTerminalPresenceStateSchema.parse(presence.state(scopeId, "shared", "Nima"));
    expect(state.participants).toEqual([
      { actorId: "user_owner", displayName: "Nima", role: "owner", connections: 0 },
      { actorId: "user_yuhan", displayName: "Yuhan", role: "editor", connections: 2 },
      { actorId: "user_sam", displayName: "Sam", role: "viewer", connections: 1 },
    ]);
    presence.leave(scopeId, "c1");
    expect(presence.state(scopeId, "shared").participants.find((p) => p.actorId === "user_yuhan")?.connections).toBe(1);
    presence.leave(scopeId, "c2");
    expect(presence.state(scopeId, "shared").participants.map((p) => p.actorId)).toEqual(["user_owner", "user_sam"]);
  });

  it("records who pressed Enter where, without the keys, and shows typing briefly", () => {
    let now = 1_000;
    const presence = new TeamTerminalPresence({ onChange: vi.fn(), now: () => now });
    presence.join(scopeId, "c1", { actorId: "user_yuhan", displayName: "Yuhan", role: "editor", ...owner });
    presence.noteInput(scopeId, "user_yuhan", { ...describeTerminalInput("git status\r"), outputSeq: 42 });
    presence.noteInput(scopeId, "user_owner", { ...describeTerminalInput("y"), outputSeq: 43 });
    const state = presence.state(scopeId, "owner");
    expect(state.inputMode).toBe("owner");
    expect(state.marks).toEqual([
      { actorId: "user_yuhan", at: new Date(1_000).toISOString(), outputSeq: "42", bytes: 11, enter: true },
      { actorId: "user_owner", at: new Date(1_000).toISOString(), outputSeq: "43", bytes: 1, enter: false },
    ]);
    expect(JSON.stringify(state)).not.toContain("git status");
    expect(state.participants.find((p) => p.actorId === "user_yuhan")?.typingAt).toBe(new Date(1_000).toISOString());
    now = 10_000;
    expect(presence.state(scopeId, "shared").participants.find((p) => p.actorId === "user_yuhan")?.typingAt).toBeUndefined();
  });

  it("keeps the newest marks within the cap and drops everything when the last watcher leaves", () => {
    const presence = new TeamTerminalPresence({ onChange: vi.fn(), now: () => 0, maxMarks: 3 });
    presence.join(scopeId, "c1", { actorId: "user_yuhan", displayName: "Yuhan", role: "editor", ...owner });
    for (let seq = 1; seq <= 5; seq += 1) presence.noteInput(scopeId, "user_yuhan", { bytes: 1, enter: false, outputSeq: seq });
    expect(presence.state(scopeId, "shared").marks.map((mark) => mark.outputSeq)).toEqual(["3", "4", "5"]);
    presence.leave(scopeId, "c1");
    expect(presence.size).toBe(0);
    presence.noteInput(scopeId, "user_owner", { bytes: 1, enter: true, outputSeq: 9 });
    expect(presence.size).toBe(0);
  });

  it("coalesces change notifications to at most one per interval per scope", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const onChange = vi.fn();
    const presence = new TeamTerminalPresence({ onChange, minIntervalMs: 250 });
    presence.join(scopeId, "c1", { actorId: "user_yuhan", displayName: "Yuhan", role: "editor", ...owner });
    expect(onChange).toHaveBeenCalledTimes(1);
    for (let index = 0; index < 20; index += 1) presence.noteInput(scopeId, "user_yuhan", { bytes: 1, enter: false, outputSeq: index });
    expect(onChange).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(250);
    expect(onChange).toHaveBeenCalledTimes(2);
    presence.close();
    presence.noteInput(scopeId, "user_yuhan", { bytes: 1, enter: false, outputSeq: 99 });
    vi.advanceTimersByTime(1_000);
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it("bounds scopes and participants", () => {
    const presence = new TeamTerminalPresence({ onChange: vi.fn(), now: () => 0, maxScopes: 2 });
    for (let index = 0; index < 3; index += 1) {
      presence.join(`10000000-0000-4000-8000-00000000000${index}`, `c${index}`, { actorId: "user_a", displayName: "A", role: "editor", ...owner });
    }
    expect(presence.size).toBe(2);
    const crowded = new TeamTerminalPresence({ onChange: vi.fn(), now: () => 0 });
    for (let index = 0; index < 40; index += 1) {
      crowded.join(scopeId, `c${index}`, { actorId: `user_${index}`, displayName: `U${index}`, role: "viewer", ...owner });
    }
    expect(CollaborationTeamTerminalPresenceStateSchema.parse(crowded.state(scopeId, "shared")).participants).toHaveLength(32);
  });
});
