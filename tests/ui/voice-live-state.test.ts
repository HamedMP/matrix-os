import { describe, expect, it } from "vitest";
import { initialVoiceLiveState, parseVoiceLiveFrame, reduceVoiceLive, voiceLiveErrorMessage } from "../../packages/ui/src/voice-live/state.js";

const ready = reduceVoiceLive(initialVoiceLiveState, { type: "session.ready", chatId: "chat_voice" });

describe("voice live state", () => {
  it("moves from connecting to listening on the Chat the gateway chose", () => {
    expect(initialVoiceLiveState.status).toBe("connecting");
    expect(ready).toMatchObject({ status: "listening", chatId: "chat_voice" });
  });

  it("shows the latest caption per speaker and speaks while audio is queued", () => {
    let state = reduceVoiceLive(ready, { type: "companion.caption", speaker: "user", turnId: "vturn_a", text: "Build me", final: false, interrupted: false });
    state = reduceVoiceLive(state, { type: "companion.caption", speaker: "user", turnId: "vturn_a", text: "Build me a tracker", final: true, interrupted: false });
    state = reduceVoiceLive(state, { type: "companion.response.started", responseId: "vresp_a" });
    state = reduceVoiceLive(state, { type: "companion.caption", speaker: "assistant", turnId: "vresp_a", text: "On it.", final: false, interrupted: false });
    expect(state).toMatchObject({ status: "speaking", userCaption: "Build me a tracker", assistantCaption: "On it." });
    state = reduceVoiceLive(state, { type: "playback.idle" });
    expect(state.status).toBe("listening");
  });

  it("keeps one row per delegated task with its latest state", () => {
    let state = reduceVoiceLive(ready, { type: "companion.task", chatId: "chat_live_task_a", runId: "run_a", state: "queued", label: "Build a tracker" });
    state = reduceVoiceLive(state, { type: "companion.task", chatId: "chat_live_task_a", runId: "run_a", state: "running", label: "Build a tracker" });
    state = reduceVoiceLive(state, { type: "companion.task", chatId: "chat_live_task_b", runId: "run_b", state: "succeeded", label: "Open terminal" });
    expect(state.tasks).toEqual([
      { chatId: "chat_live_task_a", runId: "run_a", state: "running", label: "Build a tracker" },
      { chatId: "chat_live_task_b", runId: "run_b", state: "succeeded", label: "Open terminal" },
    ]);
  });

  it("ends with a known reason and maps unknown error codes to a generic message", () => {
    expect(reduceVoiceLive(ready, { type: "session.ended", reason: "idle" })).toMatchObject({ status: "ended", endReason: "idle" });
    const failed = reduceVoiceLive(ready, { type: "error", code: "provider_unavailable", retryable: true });
    expect(failed).toMatchObject({ status: "error", errorCode: "provider_unavailable" });
    expect(voiceLiveErrorMessage("provider_unavailable")).toMatch(/voice service/i);
    expect(voiceLiveErrorMessage("postgres: relation chats does not exist")).toBe("Voice stopped unexpectedly. Try again.");
  });

  it("treats a socket that closes before the call starts as voice being unavailable, not a finished call", () => {
    const refused = reduceVoiceLive(initialVoiceLiveState, { type: "socket.closed" });
    expect(refused).toMatchObject({ status: "error", errorCode: "voice_unavailable" });
    expect(voiceLiveErrorMessage("voice_unavailable")).toMatch(/not set up on this computer/i);
    expect(reduceVoiceLive(ready, { type: "socket.closed" })).toMatchObject({ status: "ended", endReason: "socket_closed" });
  });

  it("ignores frames it does not understand", () => {
    expect(parseVoiceLiveFrame("{bad")).toBeNull();
    expect(parseVoiceLiveFrame(JSON.stringify({ type: "unknown.frame" }))).toBeNull();
    expect(parseVoiceLiveFrame(JSON.stringify({ type: "session.ready", chatId: "chat_voice" }))).toEqual({ type: "session.ready", chatId: "chat_voice" });
    expect(parseVoiceLiveFrame(JSON.stringify({ type: "response.audio", responseId: "vresp_a", segmentId: "vseg_a", startMs: 0, data: "AAAA" })))
      .toMatchObject({ type: "response.audio", segmentId: "vseg_a" });
  });
});
