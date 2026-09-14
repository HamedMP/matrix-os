import { expect, it, vi } from "vitest";
import { AFTER_STEER, BEFORE_STEER, FINAL_TEXT, STEER_REQUEST, contentFrames,
  createClaudeSteerStreamHarness, messageFrame } from "../helpers/claude-steer-stream-harness";

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
      "--resume", "claude_stream_session", "--include-partial-messages", "--", STEER_REQUEST,
    ]));
    const resumed = h.children[1]!;
    resumed.text(AFTER_STEER, true);
    resumed.tool();
    await vi.waitFor(() => {
      expect(messageFrame(h.frames, AFTER_STEER)).toBeDefined();
      expect(contentFrames(h.frames).flatMap((frame) => frame.content.activities ?? []))
        .toContainEqual(expect.objectContaining({ preview: "src/streaming.ts" }));
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
