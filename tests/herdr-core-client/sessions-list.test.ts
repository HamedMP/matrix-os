import { describe, expect, it } from "vitest";
import type { HcConnection } from "@matrix-os/herdr-core-client/client";
import { createAttachmentSlots, createHcSessions } from "@matrix-os/herdr-core-client/sessions";

// Spec 2701: terminals started from the Herdr app or `hc run` carry no title of
// their own. Found on a live VPS: every one showed as "Terminal", so a person
// with several Herdr sessions could not tell them apart in Matrix.
function sessionsListing(terminals: unknown[]) {
  const core = {
    call: async (method: string) => {
      if (method !== "terminal.list") throw new Error(`unexpected ${method}`);
      return { terminals };
    },
  } as unknown as HcConnection;
  const sink = {} as Parameters<typeof createHcSessions>[1];
  return createHcSessions({ ensure: async () => core, slots: createAttachmentSlots() }, sink);
}

describe("herdr-core terminal titles", () => {
  it("names a terminal by its where label, then its program, before falling back", async () => {
    const sessions = sessionsListing([
      { address: "t1", state: "live", labels: { where: "herdr-test top" }, argv: ["top"], cwd: "/home/tester" },
      { address: "t2", state: "live", labels: {}, argv: ["/usr/bin/bash", "-l"], cwd: "/home/tester" },
      { address: "t3", state: "live", labels: { "matrix.title": "Renamed", where: "x" }, argv: ["bash"] },
      { address: "t4", state: "live" },
    ]);
    const titles = (await sessions.list()).map((terminal) => [terminal.id, terminal.title]);
    expect(titles).toEqual([["t1", "herdr-test top"], ["t2", "bash"], ["t3", "Renamed"], ["t4", "Terminal"]]);
  });

  it("strips control and bidirectional characters from label and program titles", async () => {
    const sessions = sessionsListing([
      { address: "t1", state: "live", labels: { where: "‮evil\u0007" }, argv: ["top"] },
    ]);
    expect((await sessions.list())[0]?.title).toBe("evil");
  });
});

// Fault detected (review, ENG-574): starts run one at a time and each call's timeout began
// only when it left the queue, so a start its caller had given up on still launched later.
describe("herdr-core terminal starts", () => {
  it("never sends a start that waited past its deadline, and gives the core only the time left", async () => {
    let clock = 0;
    const sent: Array<{ params: Record<string, unknown>; timeoutMs: number | undefined }> = [];
    let finishFirst: () => void = () => {};
    const core = {
      call: (method: string, params: Record<string, unknown>, timeoutMs?: number) => {
        if (method !== "terminal.run") throw new Error(`unexpected ${method}`);
        sent.push({ params, timeoutMs });
        if (sent.length === 1) return new Promise((resolve) => { finishFirst = () => resolve({ address: "t1" }); });
        return Promise.resolve({ address: `t${sent.length}` });
      },
    } as unknown as HcConnection;
    const sessions = createHcSessions({ ensure: async () => core, slots: createAttachmentSlots(), now: () => clock }, {} as Parameters<typeof createHcSessions>[1]);
    const first = sessions.run({ name: "first" }, { deadlineMs: 75_000 });
    const second = sessions.run({ name: "second" }, { deadlineMs: 75_000 });
    const third = sessions.run({ name: "third" }, { deadlineMs: 100_000 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sent.map((call) => call.timeoutMs)).toEqual([75_000]);
    clock = 80_000;
    finishFirst();
    expect(await first).toBe("t1");
    await expect(second).rejects.toThrow("terminal start expired");
    expect(await third).toBe("t2");
    expect(sent.map((call) => call.params.name)).toEqual(["first", "third"]);
    expect(sent[1]!.timeoutMs).toBe(20_000);
  });
});
