import { expect, it, vi } from "vitest";
import { hermesStartupStreamHarness } from "../helpers/hermes-startup-stream-harness";

it.each(["eventual_exit", "user_stop", "shutdown"] as const)(
  "retains post-ready protocol-failure ownership through HTTP until %s", async (mode) => {
    const h = await hermesStartupStreamHarness({ confirmExit: false });
    try {
      await h.source.start();
      const admitted = await h.admit();
      await vi.waitFor(() => expect(h.process.requests().filter((request) => request.method === "prompt.submit")).toHaveLength(1));
      const drained = h.orchestrator.drain();
      h.process.children[0]!.process.stdout.emit("data", Buffer.from("invalid\n"));
      await vi.waitFor(() => expect(h.frames.flatMap((frame) => frame.content.activities ?? []))
        .toContainEqual(expect.objectContaining({ label: "Stopping", status: "running" })), { timeout: 3_000 });
      expect(h.orchestrator.activeCount).toBe(1);
      expect(h.frames.some((frame) => ["run.completed", "run.failed", "run.aborted"].includes(frame.event.eventType))).toBe(false);
      await expect(h.admit("req_post_ready_duplicate", h.frames.at(-1)!.event.revision))
        .rejects.toMatchObject({ safeError: { code: "chat_busy" } });
      if (mode === "user_stop") await h.orchestrator.cancelRun(h.owner, h.chatId, admitted.run.id);
      else if (mode === "shutdown") await h.orchestrator.close();
      h.process.children[0]!.event("message.delta", { text: "Late retired output" });
      h.process.children[0]!.exit();
      await drained;
      await vi.waitFor(() => expect(h.frames.at(-1)?.content.record.activeRun).toBeUndefined());
      expect(h.frames.filter((frame) => ["run.completed", "run.failed", "run.aborted"].includes(frame.event.eventType))).toHaveLength(1);
      const terminal = h.frames.flatMap((frame) => frame.content.runs ?? []).filter((run) => run.id === admitted.run.id).at(-1);
      expect(terminal?.status).toBe(mode === "eventual_exit" ? "failed" : "aborted");
      expect(h.frames.some((frame) => frame.content.messageDelta)).toBe(false);
      expect(h.process.children).toHaveLength(1);
      expect(h.orchestrator.activeCount).toBe(0);
    } finally { await h.close(); }
  }, 15_000,
);

it("rechecks direct dispatch when Stop commits during awaited admission preparation", async () => {
  const h = await hermesStartupStreamHarness({ timeouts: 6, confirmExit: false });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  try {
    await h.source.start();
    const admitted = await h.admit();
    await vi.waitFor(() => expect(h.frames.flatMap((frame) => frame.content.activities ?? []))
      .toContainEqual(expect.objectContaining({ label: "Stopping", status: "running" })), { timeout: 3_000 });
    const before = await h.repository.get(h.owner, h.chatId);
    const originalGet = h.repository.get.bind(h.repository);
    let entered = false;
    vi.spyOn(h.repository, "get").mockImplementationOnce(async (...args) => {
      entered = true;
      await gate;
      return originalGet(...args);
    });
    // A competing client can submit the next revision while Stop is committing.
    const next = h.admit("req_cancel_admission_race", before!.chat.revision + 1);
    const rejected = expect(next).rejects.toMatchObject({ safeError: { code: "chat_busy" } });
    await vi.waitFor(() => expect(entered).toBe(true));
    await h.orchestrator.cancelRun(h.owner, h.chatId, admitted.run.id);
    expect((await originalGet(h.owner, h.chatId))!.chat.revision).toBe(before!.chat.revision + 1);
    release();
    await rejected;
    expect(h.orchestrator.activeCount).toBe(1);
    expect(h.process.children).toHaveLength(1);
    expect(h.process.requests()).toEqual([]);
  } finally { release(); await h.close(); }
}, 10_000);

it.each(["user_stop", "shutdown"] as const)(
  "retains early %s cleanup ownership until the startup child actually exits", async (mode) => {
    const h = await hermesStartupStreamHarness({ timeouts: 6, confirmExit: false });
    try {
      await h.source.start();
      await vi.waitFor(() => expect(h.source.connectionState()).toBe("open"));
      const admitted = await h.admit();
      await vi.waitFor(() => expect(h.process.children).toHaveLength(1));
      let settled = false;
      const drained = h.orchestrator.drain().then(() => { settled = true; });
      if (mode === "user_stop") await h.orchestrator.cancelRun(h.owner, h.chatId, admitted.run.id);
      else await h.orchestrator.close();
      // Observe the public cleanup diagnostic or controlled process stop, then
      // cross the bounded close window without releasing the actual child exit.
      await vi.waitFor(() => expect(h.process.children[0]!.process.kill).toHaveBeenCalledWith("SIGKILL"), { timeout: 3_000 });
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(settled).toBe(false);
      // Stop already persists its established user-visible aborted outcome;
      // execution ownership must still prevent more work until cleanup finishes.
      expect(h.frames.filter((frame) => frame.event.eventType === "run.aborted")).toHaveLength(1);
      if (mode === "user_stop") {
        expect(h.orchestrator.activeCount).toBe(1);
        expect(await h.admit()).toMatchObject({ admission: "already_accepted" });
        await expect(h.admit("req_early_stop_duplicate", h.frames.at(-1)!.event.revision))
          .rejects.toMatchObject({ safeError: { code: "chat_busy" } });
        await expect(h.orchestrator.retryTurn({ userId: h.owner.ownerId, source: "jwt" }, h.owner,
          h.chatId, admitted.turn.id, { clientRequestId: "req_early_retry", baseRevision: h.frames.at(-1)!.event.revision }))
          .rejects.toMatchObject({ safeError: { code: "chat_busy" } });
      }
      h.process.children[0]!.event("gateway.ready");
      h.process.children[0]!.event("message.complete", { text: "Late unowned result", status: "complete" });
      expect(h.process.requests()).toEqual([]);
      h.process.children[0]!.exit();
      await drained;
      await vi.waitFor(() => expect(h.frames.at(-1)?.content.record.activeRun).toBeUndefined());
      expect(h.frames.filter((frame) => frame.event.eventType === "run.aborted")).toHaveLength(1);
      expect(h.frames.some((frame) => frame.content.messageDelta)).toBe(false);
      expect(h.process.children).toHaveLength(1);
    } finally { await h.close(); }
  }, 15_000,
);

it.each(["eventual_exit", "user_stop", "shutdown"] as const)(
  "keeps Hermes startup cleanup owned through HTTP until %s and settles once", async (mode) => {
    const h = await hermesStartupStreamHarness({ timeouts: 6, confirmExit: false });
    try {
      await h.source.start();
      await vi.waitFor(() => expect(h.source.connectionState()).toBe("open"));
      const admitted = await h.admit();
      await vi.waitFor(() => expect(h.frames.flatMap((frame) => frame.content.activities ?? []))
        .toContainEqual(expect.objectContaining({ label: "Stopping", status: "running" })), { timeout: 3_000 });
      expect(h.frames.at(-1)?.content.record.activeRun).toMatchObject({ runId: admitted.run.id });
      expect(h.frames.some((frame) => ["run.completed", "run.failed", "run.aborted"].includes(frame.event.eventType))).toBe(false);
      expect(h.process.children).toHaveLength(1);
      expect(h.process.requests()).toEqual([]);
      expect(h.orchestrator.activeCount).toBe(1);
      // Capture the active completion before bounded shutdown clears its registry.
      // Keep the test DB alive for late-exit callbacks that shutdown cannot await.
      const drained = h.orchestrator.drain();
      await expect(h.admit("req_duplicate_start", h.frames.at(-1)!.event.revision))
        .rejects.toMatchObject({ safeError: { code: "chat_busy" } });
      h.process.children[0]!.event("gateway.ready");
      h.process.children[0]!.event("message.complete", { text: "Late unowned result", status: "complete" });
      if (mode === "user_stop") {
        expect(await h.orchestrator.cancelRun(h.owner, h.chatId, admitted.run.id))
          .toMatchObject({ cancellation: "aborted" });
        expect(h.orchestrator.activeCount).toBe(1);
      } else if (mode === "shutdown") {
        // Returns despite no exit; shutdown's bounded drain is not exit proof.
        await h.orchestrator.close();
        expect(h.process.children[0]!.exited).toBe(false);
      }
      expect(h.process.requests()).toEqual([]);
      expect(h.process.children).toHaveLength(1);
      h.process.children[0]!.exit();
      await drained;
      await vi.waitFor(() => expect(h.frames.at(-1)?.content.record.activeRun).toBeUndefined());
      expect(h.frames.filter((frame) => ["run.completed", "run.failed", "run.aborted"].includes(frame.event.eventType))).toHaveLength(1);
      const terminal = h.frames.flatMap((frame) => frame.content.runs ?? [])
        .filter((run) => run.id === admitted.run.id).at(-1);
      expect(terminal?.status).toBe(mode === "eventual_exit" ? "failed" : "aborted");
      expect(h.frames.some((frame) => frame.content.messageDelta)).toBe(false);
      expect(h.process.children).toHaveLength(1);
      expect(h.orchestrator.activeCount).toBe(0);
    } finally { await h.close(); }
  }, 15_000,
);

it("publishes Hermes Reconnecting through HTTP with one admitted run and no failure flash", async () => {
  const h = await hermesStartupStreamHarness({ timeouts: 1 });
  try {
    await h.source.start();
    await vi.waitFor(() => expect(h.source.connectionState()).toBe("open"));
    const admitted = await h.admit();
    await vi.waitFor(() => expect(h.frames.flatMap((frame) => frame.content.activities ?? []))
      .toContainEqual(expect.objectContaining({ label: "Reconnecting… 1/5", status: "running" })));
    expect(h.frames.some((frame) => frame.event.eventType === "run.completed")).toBe(false);
    expect(h.frames.at(-1)?.content.record.activeRun?.runId).toBe(admitted.run.id);
    await vi.waitFor(() => expect(h.process.requests().filter((request) => request.method === "prompt.submit")).toHaveLength(1));
    h.process.children[1]!.event("message.complete", { text: "Recovered startup.", status: "complete" });
    await h.orchestrator.drain();
    await vi.waitFor(() => expect(h.frames.at(-1)?.content.record.activeRun).toBeUndefined());
    expect(h.frames.filter((frame) => frame.event.eventType === "run.completed")).toHaveLength(1);
    expect(new Set(h.frames.flatMap((frame) => frame.content.runs ?? []).map((run) => run.id)))
      .toEqual(new Set([admitted.run.id]));
  } finally { await h.close(); }
});
