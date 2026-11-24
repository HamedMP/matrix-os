import { describe, expect, it } from "vitest";
import { EMPTY_TERMINAL_EVENTS_STATE, reduceTerminalEvents } from "../../packages/ui/src/terminal-agents/events-state.js";

const key = `tws_${"3".repeat(32)}:tt_${"4".repeat(32)}`;
const entry = {
  ref: { workspaceId: `tws_${"3".repeat(32)}`, tabId: `tt_${"4".repeat(32)}` },
  scopeId: "10000000-0000-4000-8000-000000000001",
  inputMode: "shared",
  participants: [
    { actorId: "user_owner", displayName: "Nima", role: "owner", connections: 0 },
    { actorId: "user_yuhan", displayName: "Yuhan", role: "editor", connections: 1 },
  ],
  marks: [{ actorId: "user_yuhan", at: "2026-11-24T10:00:00.000Z", outputSeq: "7", bytes: 3, enter: true }],
};

describe("team terminal owner feed on /ws/terminal/events (spec 2710)", () => {
  it("keeps who watches each shared tab, keyed like the tabs", () => {
    const state = reduceTerminalEvents(EMPTY_TERMINAL_EVENTS_STATE, { type: "team", seq: 3, tabs: { [key]: entry } });
    expect(state.team?.[key]?.participants.map((participant) => participant.displayName)).toEqual(["Nima", "Yuhan"]);
    expect(reduceTerminalEvents(state, { type: "team", seq: 4, tabs: {} }).team).toEqual({});
  });

  it("drops a malformed team frame and resets team state on a new snapshot", () => {
    const state = reduceTerminalEvents(EMPTY_TERMINAL_EVENTS_STATE, { type: "team", seq: 3, tabs: { [key]: entry } });
    expect(reduceTerminalEvents(state, { type: "team", seq: 4, tabs: { [key]: { ...entry, inputMode: "everyone" } } })).toBe(state);
    expect(reduceTerminalEvents(state, { type: "snapshot", seq: 5, tabs: [] }).team).toBeUndefined();
  });
});
