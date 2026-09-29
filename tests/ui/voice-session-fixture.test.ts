import { describe, expect, it } from "vitest";
import { runFixtureSession } from "../fixtures/voice-session/ui-fixture/src/session-runner";
import {
  durationLimitScenario,
  interruptionScenario,
  normalScenario,
  permissionDeniedScenario,
  reconnectScenario,
  usingToolScenario,
} from "../fixtures/voice-session/scenarios/index";

describe("runFixtureSession (single-pipeline fixture)", () => {
  it("drives controller, canonical harness, and UI state from one media journal", () => {
    const run = runFixtureSession(normalScenario);
    const state = run.controller.getState();

    // One deterministic script reaches all three components: the media
    // journal ended cleanly, the fake canonical boundary admitted the turn
    // and tracked its run, and the controller rendered the same lifecycle.
    expect(state.state).toBe("ended");
    expect(state.provisionalTranscript).toBeNull();
    expect(run.evidence).toMatchObject({
      mediaScenarioId: "normal",
      mediaJournalEntries: 13,
      mediaTerminalState: "ended",
      mediaResourcesClean: true,
      framesRejected: 0,
      canonicalRevision: 1,
      activeRunId: null,
      queuedRequestIds: [],
    });
    expect(run.evidence.admissions).toEqual([
      {
        requestId: "req_final-1",
        outcome: "sent",
        canonicalTurnId: "cturn_0001",
        canonicalQueuedTurnId: null,
        runId: "run_0001",
      },
    ]);
    expect(run.evidence.operations).toEqual([]);
    expect(run.evidence.deliveries).toEqual([
      { responseId: "vresp_response-1", state: "complete", revision: 3 },
    ]);
    // The acknowledged segment boundary flows through the command channel.
    expect(run.evidence.commands).toEqual(["playback.segment_played"]);
    expect(run.evidence.lastPlayedThroughMs).toBe(240);
  });

  it("reproduces identical evidence and controller state for identical scripts", () => {
    const first = runFixtureSession(normalScenario);
    const second = runFixtureSession(normalScenario);
    expect(first.controller.getState()).toEqual(second.controller.getState());
    expect(first.evidence).toEqual(second.evidence);
    expect(first.media.journal).toEqual(second.media.journal);
  });

  it("keeps an admitted run active while a tool call is in flight", () => {
    const run = runFixtureSession(usingToolScenario, { displayUntilMs: 65 });
    const state = run.controller.getState();

    expect(state.state).toBe("using_tool");
    expect(state.toolLabel).toBe("Reviewing project files");
    // The canonical side shows the run that owns the operation is still live.
    expect(run.evidence.activeRunId).toBe("run_0001");
    expect(run.evidence.operations).toEqual([{ operationId: "op-1", state: "running" }]);
  });

  it("advances the epoch only through the session.resumed transition", () => {
    const run = runFixtureSession(reconnectScenario);

    expect(run.controller.getState().epoch).toBe(2);
    expect(run.controller.getState().state).toBe("ended");
    // The mid-scenario disconnect/reconnect produced exactly one resumed
    // transition; stale-epoch replays stayed fenced.
    const resumed = run.media.journal.filter((entry) => entry.type === "transport.reconnected");
    const fenced = run.media.journal.filter((entry) => entry.type === "transport.stale_ignored");
    expect(resumed).toHaveLength(1);
    expect(fenced).toHaveLength(2);
  });

  it("surfaces safe session errors through the same pipeline", () => {
    const denied = runFixtureSession(permissionDeniedScenario);
    expect(denied.controller.getState()).toMatchObject({
      state: "failed",
      error: { code: "permission_denied", recovery: "request_permission", retryable: true },
    });

    const duration = runFixtureSession(durationLimitScenario);
    expect(duration.controller.getState()).toMatchObject({
      state: "failed",
      error: { code: "session_limit_reached", recovery: "start_new_session", retryable: false },
    });
    expect(duration.evidence.mediaResourcesClean).toBe(true);
  });

  it("records interrupted delivery and keeps conservative heard boundary", () => {
    const run = runFixtureSession(interruptionScenario);
    expect(run.evidence.deliveries).toEqual([
      { responseId: "vresp_response-1", state: "interrupted", revision: 2 },
    ]);
    expect(run.controller.getState().state).toBe("ended");
  });
});
