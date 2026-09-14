import { expect, it, vi } from "vitest";
import { createCodexStartupStreamHarness } from "../helpers/codex-startup-stream-harness";

it("streams Reconnecting before the Codex prompt is sent, without an intermediate failed Run", async () => {
  const h = await createCodexStartupStreamHarness();
  const controller = new AbortController();
  const reader = (await h.openStream({ signal: controller.signal })).body!.getReader();
  const reading = (async () => { while (!(await reader.read()).done) { /* Consume real HTTP. */ } })();
  try {
    await vi.waitFor(() => expect(h.frames.at(-1)?.type).toBe("chat.replay.end"));
    await h.admit();
    await vi.waitFor(() => expect(h.frames.some((frame) => frame.type === "chat.content"
      && frame.content.activities?.some((activity) => activity.type === "agent.activity"
        && activity.kind === "phase" && activity.label === "Reconnecting… 1/5"))).toBe(true), { timeout: 4_000 });
    expect(h.frames.some((frame) => frame.type === "chat.content" && frame.event.eventType === "run.failed")).toBe(false);
    expect((await h.getRunner()!.requests()).some((request) => request.method === "turn/start")).toBe(false);
    await h.release();
    await vi.waitFor(() => expect(h.frames.some((frame) => frame.type === "chat.content"
      && frame.event.eventType === "run.completed")).toBe(true), { timeout: 4_000 });
    expect((await h.getRunner()!.requests()).filter((request) => request.method === "turn/start")).toHaveLength(1);
  } finally {
    controller.abort(); await reader.cancel(); await reading; await h.close();
  }
}, 15_000);
