import { describe, expect, it, vi } from "vitest";
import type { tool as sdkTool } from "@anthropic-ai/claude-agent-sdk";
import { createBrainIpcTools } from "../../packages/kernel/src/tools/brain-ipc-tools.js";

const notFound = async () => ({ status: "not_found" as const });

function fakeTool() {
  return vi.fn((name: string, _description: string, _shape: unknown, handler: unknown, extras?: unknown) =>
    ({ name, handler, extras })) as unknown as typeof sdkTool & ReturnType<typeof vi.fn>;
}

describe("createBrainIpcTools", () => {
  it("registers nothing when the gateway injects no brain tools", () => {
    const tool = fakeTool();
    expect(createBrainIpcTools(tool)).toEqual([]);
    expect(tool).not.toHaveBeenCalled();
  });

  it("registers brain_why first, then each injected read tool in order, all read-only", () => {
    const tool = fakeTool();
    const registered = createBrainIpcTools(tool, { why: notFound }, { impact: notFound, search: notFound });
    expect(registered.map((definition) => definition.name)).toEqual(["brain_why", "brain_search", "brain_impact"]);
    expect(tool.mock.calls.map((call) => call[4])).toEqual(
      Array.from({ length: 3 }, () => ({ annotations: { readOnlyHint: true } })),
    );
  });

  it("registers the read tools without brain_why when only they are injected", () => {
    const registered = createBrainIpcTools(fakeTool(), undefined, { brief: notFound });
    expect(registered.map((definition) => definition.name)).toEqual(["brain_brief"]);
  });
});
