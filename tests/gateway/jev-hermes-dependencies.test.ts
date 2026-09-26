import { expect, it, vi } from "vitest";
import { verifyJevHermesDependencies } from "../../packages/gateway/src/chat/jev-hermes-runtime-pin.js";
it("requires the exact spike-tested Anthropic SDK to import in isolated Python before launch", async () => {
  const command = vi.fn(async (_executable: string, _args: string[], _signal: AbortSignal) => "0.87.0\n");
  await verifyJevHermesDependencies("/fixture/hermes", new AbortController().signal, command);
  expect(command).toHaveBeenCalledWith("/fixture/hermes/venv/bin/python", expect.arrayContaining(["-I", "-c"]), expect.any(AbortSignal));
  expect(command.mock.calls[0]![1].join(" ")).toContain("import anthropic");
});
it.each(["", "0.86.0\n", "0.87.0\nextra", "missing"])("denies unavailable/mismatched dependency %j", async (value) => {
  await expect(verifyJevHermesDependencies("/fixture/hermes", new AbortController().signal,
    async () => { if (value === "missing") throw new Error("fixture missing package"); return value; })).rejects.toThrow();
});
