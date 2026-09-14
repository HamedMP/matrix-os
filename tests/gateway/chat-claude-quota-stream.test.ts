import { expect, it, vi } from "vitest";
import { contentFrames, createClaudeSteerStreamHarness } from "../helpers/claude-steer-stream-harness";

it.each(["assistant", "result"])("publishes one safe %s quota failure over live HTTP SSE", async (envelope) => {
  const h = await createClaudeSteerStreamHarness();
  const controller = new AbortController();
  const response = await h.openStream({ signal: controller.signal });
  const reader = response.body!.getReader();
  const reading = (async () => { while (!(await reader.read()).done) { /* Consume the real wire. */ } })();
  try {
    await vi.waitFor(() => expect(h.frames.at(-1)?.type).toBe("chat.replay.end"));
    await h.admit();
    await vi.waitFor(() => expect(h.children).toHaveLength(1));
    const text = "You've hit your weekly limit · resets Sep 14, 1pm (unverified timezone) /opt/private token=private";
    h.children[0]!.line(envelope === "assistant"
      ? { type: "assistant", error: "rate_limit", isApiErrorMessage: true,
          message: { role: "assistant", content: [{ type: "text", text }] } }
      : { type: "result", is_error: true, result: text });
    h.children[0]!.exit(1);
    await h.orchestrator.drain();
    await vi.waitFor(() => expect(contentFrames(h.frames).some((frame) => frame.event.eventType === "run.failed")).toBe(true));
    const terminal = contentFrames(h.frames).filter((frame) => frame.event.eventType === "run.failed");
    expect(terminal).toHaveLength(1);
    const errors = terminal.flatMap((frame) => frame.content.activities ?? [])
      .filter((activity) => activity.type === "run.error");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ error: {
      code: "run_failed", safeMessage: "Your usage limit has been reached. Try again after your allowance resets.",
      retryable: false,
    } });
    expect(JSON.stringify(h.frames)).not.toMatch(/Check its connection|Reconnecting|\/opt\/private|token=private|unverified timezone/);
    expect(h.spawn).toHaveBeenCalledTimes(1);
  } finally {
    controller.abort();
    await reader.cancel();
    await reading;
    await h.close();
  }
}, 20_000);
