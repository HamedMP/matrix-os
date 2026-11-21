import { expect, it, vi } from "vitest";
import { AFTER_STEER, BEFORE_STEER, FINAL_TEXT, STEER_REQUEST, contentFrames,
  createClaudeSteerStreamHarness, messageFrame } from "../helpers/claude-steer-stream-harness";

it("delivers both accepted corrections when Claude is still closing after the first Steer", async () => {
  const h = await createClaudeSteerStreamHarness();
  try {
    const admitted = await h.admit();
    await vi.waitFor(() => expect(h.children).toHaveLength(1));
    await vi.waitFor(async () => expect((await h.getDetail()).record.activeRun?.status).toBe("running"));
    // Real process shutdown is asynchronous. Hold only this external boundary.
    vi.spyOn(h.children[0]!, "kill").mockImplementation(() => undefined);
    const first = await h.steer(admitted.run.id, admitted.turn.id);
    const second = await h.orchestrator.steerRun(h.owner, h.chatId, admitted.run.id, {
      clientRequestId: "req_second_correction", expectedTurnId: admitted.turn.id,
      parts: [{ type: "text", text: "Also preserve the cancellation behavior." }],
    });
    expect(first.steering).toBe("accepted");
    expect(second.steering).toBe("accepted");
    h.children[0]!.exit(null, "SIGTERM");
    await vi.waitFor(() => expect(h.children).toHaveLength(2));
    const inputs = JSON.stringify(h.children[1]!.inputFrames);
    expect(inputs).toContain(STEER_REQUEST);
    expect(inputs).toContain("Also preserve the cancellation behavior.");
    expect(inputs.split(STEER_REQUEST)).toHaveLength(2);
    h.children[1]!.finish();
    await h.orchestrator.drain();
    const detail = await h.getDetail();
    expect(detail.messages.filter(message => message.role === "user")).toHaveLength(3);
    expect(detail.record.activeRun).toBeUndefined();
  } finally {
    h.children[0]?.exit(null, "SIGTERM");
    h.children[1]?.finish();
    await h.close();
  }
}, 20_000);

it("does not acknowledge a correction after Claude has already emitted its result", async () => {
  const h = await createClaudeSteerStreamHarness();
  try {
    const admitted = await h.admit();
    await vi.waitFor(() => expect(h.children).toHaveLength(1));
    await vi.waitFor(async () => expect((await h.getDetail()).record.activeRun?.status).toBe("running"));
    h.children[0]!.line({ type: "result", subtype: "success", is_error: false,
      result: "Already finished", session_id: "claude_stream_session" });
    await expect(h.steer(admitted.run.id, admitted.turn.id)).rejects.toMatchObject({ status: 503 });
    h.children[0]!.exit(0);
    await h.orchestrator.drain();
    expect(h.children).toHaveLength(1);
    expect((await h.getDetail()).messages.filter(message => message.role === "user")).toHaveLength(1);
  } finally {
    h.children[0]?.exit(0);
    await h.close();
  }
}, 20_000);

it("refuses a new correction that would make accepted shutdown input invalid", async () => {
  const h = await createClaudeSteerStreamHarness();
  try {
    const admitted = await h.admit();
    await vi.waitFor(() => expect(h.children).toHaveLength(1));
    await vi.waitFor(async () => expect((await h.getDetail()).record.activeRun?.status).toBe("running"));
    vi.spyOn(h.children[0]!, "kill").mockImplementation(() => undefined);
    const steer = (clientRequestId: string, text: string) => h.orchestrator.steerRun(h.owner, h.chatId, admitted.run.id, {
      clientRequestId, expectedTurnId: admitted.turn.id, parts: [{ type: "text", text }],
    });
    await expect(steer("req_large_first", "A".repeat(20_000))).resolves.toMatchObject({ steering: "accepted" });
    await expect(steer("req_large_second", "B".repeat(20_000))).rejects.toMatchObject({ status: 503 });
    h.children[0]!.exit(null, "SIGTERM");
    await vi.waitFor(() => expect(h.children).toHaveLength(2));
    expect(JSON.stringify(h.children[1]!.inputFrames)).toContain("A".repeat(20_000));
    expect(JSON.stringify(h.children[1]!.inputFrames)).not.toContain("B".repeat(100));
    h.children[1]!.finish();
    await h.orchestrator.drain();
    expect((await h.getDetail()).messages.filter(message => message.role === "user")).toHaveLength(2);
  } finally {
    h.children[0]?.exit(null, "SIGTERM");
    h.children[1]?.finish();
    await h.close();
  }
}, 20_000);

it("publishes accepted Claude Steer text and tool progress over HTTP before result or exit", async () => {
  const h = await createClaudeSteerStreamHarness();
  const controller = new AbortController();
  const response = await h.openStream({ signal: controller.signal });
  const reader = response.body!.getReader();
  const reading = (async () => { while (!(await reader.read()).done) { /* Observe wire frames in the harness. */ } })();
  try {
    await vi.waitFor(() => expect(h.frames.at(-1)?.type).toBe("chat.replay.end"));
    const admitted = await h.admit();
    await vi.waitFor(() => expect(h.children).toHaveLength(1));
    h.children[0]!.text(BEFORE_STEER);
    await vi.waitFor(() => expect(messageFrame(h.frames, BEFORE_STEER)).toBeDefined());
    expect(h.children[0]!.exited).toBe(false);

    expect(await h.steer(admitted.run.id, admitted.turn.id)).toMatchObject({ steering: "accepted" });
    await vi.waitFor(() => expect(h.children).toHaveLength(2));
    expect(h.children[0]!.exited).toBe(true);
    expect(h.spawn.mock.calls[1]?.[1]).toEqual(expect.arrayContaining([
      "--resume", "claude_stream_session", "--include-partial-messages", "--input-format", "stream-json",
    ]));
    const resumed = h.children[1]!;
    expect(resumed.inputFrames).toContainEqual(expect.objectContaining({ type: "user", message: { role: "user", content: STEER_REQUEST } }));
    resumed.text(AFTER_STEER, true);
    resumed.tool();
    await vi.waitFor(() => {
      expect(messageFrame(h.frames, AFTER_STEER)).toBeDefined();
      expect(contentFrames(h.frames).flatMap((frame) => frame.content.activities ?? []))
        .toContainEqual(expect.objectContaining({ preview: "/safe/project/src/streaming.ts" }));
    });
    const before = messageFrame(h.frames, BEFORE_STEER)!.content.messageDelta!.message;
    const afterFrame = messageFrame(h.frames, AFTER_STEER)!;
    const after = afterFrame.content.messageDelta!.message;
    expect(after.id).not.toBe(before.id);
    expect(after.seq).toBeGreaterThan(before.seq);
    expect(afterFrame.content.record.activeRun).toMatchObject({ runId: admitted.run.id, status: "running" });
    expect(resumed.resultReleased).toBe(false);
    expect(resumed.exited).toBe(false);
    expect(messageFrame(h.frames, FINAL_TEXT)).toBeUndefined();

    resumed.finish();
    await h.orchestrator.drain();
    await vi.waitFor(() => expect(contentFrames(h.frames).at(-1)?.content.record.activeRun).toBeUndefined());
    expect(contentFrames(h.frames).filter((frame) => frame.event.eventType === "run.completed")).toHaveLength(1);
    expect(messageFrame(h.frames, FINAL_TEXT)).toBeDefined();
  } finally {
    controller.abort();
    await reader.cancel();
    await reading;
    await h.close();
  }
}, 20_000);
