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
