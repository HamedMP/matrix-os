import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const startupSource = readFileSync(fileURLToPath(new URL(
  "../../packages/gateway/src/startup/collaboration.ts", import.meta.url,
)), "utf8");
const wiringSource = readFileSync(fileURLToPath(new URL(
  "../../packages/gateway/src/collaboration/wiring.ts", import.meta.url,
)), "utf8");
const runtimeSource = readFileSync(fileURLToPath(new URL(
  "../../packages/terminal-runtime/src/socket-client.ts", import.meta.url,
)), "utf8");

describe("production shared-terminal composition", () => {
  it("connects the current workspace/tab runtime before collaboration routes register", () => {
    expect(startupSource).toContain("createCanonicalTerminalCollaborationBridge");
    expect(startupSource).toContain("runtime.enableSharedTerminal({");
    expect(startupSource.indexOf("runtime.enableSharedTerminal({"))
      .toBeLessThan(startupSource.indexOf("runtime.enableSharedProject({"));
    expect(wiringSource).toContain("...(terminalDispatcher && terminalEventRegistry && terminalControl");
  });

  it("requires a workspace/tab bridge rather than the retired name-based shell API", () => {
    expect(runtimeSource).toContain("async listWorkspaces()");
    expect(runtimeSource).toContain("async writeInput(");
    expect(runtimeSource).toContain("async terminateTab(");
    expect(runtimeSource).not.toContain("async bindCollaboration(");
    expect(startupSource).toContain("terminalWorkspaceRuntime");
  });
});
