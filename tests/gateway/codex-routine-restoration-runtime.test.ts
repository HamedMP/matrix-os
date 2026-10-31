import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { startRestorationRunner, restorationId } from "../helpers/codex-routine-restoration.js";

it("feature-created native thread resumes after actual child renewal with its original history and a fresh private turn/generation", async () => {
  const home = await mkdtemp("/tmp/rr-"); const rig = await startRestorationRunner(home, "feature", { prompt: "Original feature history" });
  try {
    await rig.first(restorationId(1)); await rig.completed(1);
    rig.send({ type: "host.turn", admissionId: restorationId(2), first: false, clientRequestId: "req_renewal_second", turn: { prompt: "Continue original history", modelOptions: [], browser: { attemptId: restorationId(3), token: "a".repeat(43), gatewayPort: 18765 } } });
    await rig.waitFrame(frame => frame.type === "shim.bound" && frame.admissionId === restorationId(2)); await rig.completed(2);
    const frames = await rig.frames(), starts = frames.filter(frame => frame.method === "thread/start"), resumes = frames.filter(frame => frame.method === "thread/resume");
    expect(starts).toHaveLength(1); expect(starts[0].params!.dynamicTools).toEqual([expect.objectContaining({ name: "matrix_routines" })]);
    expect(resumes).toHaveLength(1); expect(resumes[0].params).toMatchObject({ threadId: "fixture_native_thread", excludeTurns: true }); expect(resumes[0].params).not.toHaveProperty("dynamicTools");
    expect(frames.filter(frame => frame.method === "thread/fork")).toHaveLength(0);
    const processes = frames.filter(frame => frame.fixtureEvent === "native.start"); expect(processes).toHaveLength(2); expect(processes[0].pid).not.toBe(processes[1].pid);
    const exited = frames.findIndex(frame => frame.fixtureEvent === "native.exit"); expect(exited).toBeGreaterThanOrEqual(0); expect(exited).toBeLessThan(frames.lastIndexOf(processes[1]));
    const bindings = rig.messages.filter(frame => frame.type === "shim.bound"); expect(bindings).toHaveLength(2);
    expect(bindings[0].nativeGeneration).not.toBe(bindings[1].nativeGeneration);
    expect(bindings.map(frame => frame.admissionId)).toEqual([restorationId(1), restorationId(2)]);
    expect(rig.messages.filter(frame => frame.type === "shim.call").map(frame => frame.admissionId)).toEqual([restorationId(1), restorationId(2)]);
    expect((await rig.history()).prompts).toEqual(["Original feature history", "Continue original history"]);
    expect(await readFile(rig.historyFile, "utf8")).not.toContain(restorationId(1));
  } finally { await rig.close(); await rm(home, { recursive: true, force: true }); }
}, 15000);

it.each(["pre-feature checkpoint", "new restored feature runner"] as const)("%s preserves native thread/history through actual resume and reports routine unavailability", async variant => {
  const home = await mkdtemp("/tmp/rr-"); let original: Awaited<ReturnType<typeof startRestorationRunner>> | undefined;
  let restored: Awaited<ReturnType<typeof startRestorationRunner>> | undefined;
  try {
    if (variant === "pre-feature checkpoint") await writeFile(join(home, "native-history.json"), JSON.stringify({ threadId: "fixture_native_thread", prompts: ["Original legacy history"], turnCount: 1, dynamicTools: [] }));
    else {
      original = await startRestorationRunner(home, "original", { prompt: "Original feature history" });
      await original.first(restorationId(10)); await original.completed(1); await original.close();
    }
    const before = JSON.parse(await readFile(join(home, "native-history.json"), "utf8"));
    restored = await startRestorationRunner(home, "restored", { prompt: "Continue exact checkpoint", providerThreadId: before.threadId });
    await restored.first(restorationId(11)); await restored.completed(1);
    const frames = await restored.frames(); expect(frames.filter(frame => frame.method === "thread/start" || frame.method === "thread/fork")).toHaveLength(0);
    expect(frames.filter(frame => frame.method === "thread/resume")).toEqual([expect.objectContaining({ params: expect.objectContaining({ threadId: before.threadId }) })]);
    expect(frames.find(frame => frame.method === "thread/resume")!.params).not.toHaveProperty("dynamicTools");
    expect(restored.messages.filter(frame => frame.type === "shim.bound" || frame.type === "shim.call")).toHaveLength(0);
    expect(restored.messages).toContainEqual({ type: "shim.end", admissionId: restorationId(11) });
    expect(frames.find(frame => frame.id === 207 && !frame.method)?.result).toMatchObject({ success: false, contentItems: [expect.objectContaining({ type: "inputText" })] });
    const after = await restored.history(); expect(after.threadId).toBe(before.threadId); expect(after.prompts).toEqual([...before.prompts, "Continue exact checkpoint"]); expect(after.dynamicTools).toEqual(before.dynamicTools);
  } finally { await restored?.close(); await original?.close(); await rm(home, { recursive: true, force: true }); }
}, 15000);
