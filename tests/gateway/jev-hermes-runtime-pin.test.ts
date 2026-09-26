import { describe, expect, it, vi } from "vitest";
import { verifyJevHermesRuntimePin } from "../../packages/gateway/src/chat/jev-hermes-runtime-pin.js";
const pin = "d337b736aa1e8ebecfab043842d13e4a2d2f48a3";
describe("restricted Hermes launch verifies tested installed source", () => {
  it("requires exact pin and no tracked modifications with bounded non-shell commands", async () => {
    const command = vi.fn(async (_args: string[], _signal: AbortSignal) => `${pin}\n`);
    await verifyJevHermesRuntimePin("/home/matrix/home/.hermes/hermes-agent", new AbortController().signal, command);
    expect(command).toHaveBeenCalledTimes(2);
    expect(command.mock.calls[0]![0]).toContain("rev-parse");
    expect(command.mock.calls[1]![0]).toContain("diff-index");
    expect(command.mock.calls[1]![0]).toContain("--no-ext-diff");
    expect(command.mock.calls[1]![0]).toContain("--no-textconv");
  });
  it.each(["wrong-pin", "dirty", "abort"])("denies %s before native session/inference", async (mode) => {
    const controller = new AbortController(); if (mode === "abort") controller.abort();
    const command = vi.fn(async (args: string[]) => {
      if (mode === "dirty" && args.includes("diff-index")) throw new Error("fixture dirty tree");
      return `${mode === "wrong-pin" ? "b".repeat(40) : pin}\n`;
    });
    await expect(verifyJevHermesRuntimePin("/fixture/hermes", controller.signal, command)).rejects.toThrow();
    if (mode === "abort") expect(command).not.toHaveBeenCalled();
  });
});
