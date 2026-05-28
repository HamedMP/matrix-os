import React from "react";
import { renderToString } from "ink";
import { describe, expect, it } from "vitest";
import { SyncViews } from "../../src/cli/tui/views/SyncViews.js";
import { InstanceViews } from "../../src/cli/tui/views/InstanceViews.js";

describe("sync and instance setup views", () => {
  it("renders sync setup with default path and pause/resume state", () => {
    const output = renderToString(<SyncViews state={{ daemon: "stopped", syncPath: "~/matrixos", peerCount: 0, paused: false }} noColor />);

    expect(output).toContain("Sync setup");
    expect(output).toContain("~/matrixos");
    expect(output).toContain("Start sync");
  });

  it("renders instance status, logs, and restart recovery actions", () => {
    const output = renderToString(<InstanceViews state={{ handle: "nim", health: "degraded", logsAvailable: true, restartEligible: true }} noColor />);

    expect(output).toContain("Instance nim");
    expect(output).toContain("degraded");
    expect(output).toContain("Logs");
    expect(output).toContain("Restart");
  });
});
