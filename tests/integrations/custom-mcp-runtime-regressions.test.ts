import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createIntegrationApprovalHook } from "../../packages/kernel/src/hooks.js";
import { describeCustomMcpServerHandler } from "../../packages/kernel/src/tools/integrations.js";

describe("custom MCP runtime contracts", () => {
  it("uses configured agent type, not runtime agent ID, for frontmatter grants", async () => {
    const home = await mkdtemp(join(tmpdir(), "matrix-review-hook-"));
    try {
      await mkdir(join(home, "system"));
      await writeFile(join(home, "system", "mcp-servers.json"), JSON.stringify({ version: 1, servers: [{ id: "research", name: "Research", enabled: true, tools: [{ name: "search", enabled: true, approval: "allow" }] }] }));
      const hook = createIntegrationApprovalHook(home, vi.fn(async () => true), { researcher: ["Research"] });
      const input = { hook_event_name: "PreToolUse", tool_name: "mcp__matrix-os-ipc__call_custom_mcp_tool", tool_input: { server_id: "research", tool: "search" }, session_id: "session", agent_id: "a8f231c-runtime-instance", agent_type: "researcher" };
      expect((await hook(input)).hookSpecificOutput?.permissionDecision).toBeUndefined();
      for (const agent_type of [undefined, "unknown", "constructor", "toString"]) {
        expect((await hook({ ...input, agent_type })).hookSpecificOutput?.permissionDecision).toBe("deny");
      }
    } finally { await rm(home, { recursive: true, force: true }); }
  });

  it("describes the required input schema to agents", async () => {
    const response = await describeCustomMcpServerHandler({ server_id: "server" }, async () => new Response(JSON.stringify({ id: "server", name: "Search", status: "ready", enabled: true, revision: 1,
      tools: [{ name: "lookup", description: "Lookup", enabled: true, approval: "allow", inputSchema: { type: "object", required: ["needle"], properties: { needle: { type: "string" } } } }],
    }), { status: 200 }));
    expect(JSON.stringify(response)).toContain("needle");
    expect(JSON.stringify(response)).toContain("EXTERNAL_UNTRUSTED_CONTENT");
  });

  it("does not return a partial oversized schema as an executable contract", async () => {
    const response = await describeCustomMcpServerHandler({ server_id: "server" }, async () => new Response(JSON.stringify({
      id: "server", name: "Search", status: "ready", enabled: true, revision: 1,
      tools: [{ name: "lookup", enabled: true, approval: "allow",
        inputSchema: { type: "object", description: "x".repeat(20_000) } }],
    }), { status: 200 }));
    expect(JSON.stringify(response)).toContain("too large");
    expect(JSON.stringify(response).length).toBeLessThan(2_000);
  });

  it("bounds the combined inventory and excludes disabled tools", async () => {
    const response = await describeCustomMcpServerHandler({ server_id: "server" }, async () => new Response(JSON.stringify({
      id: "server", name: "Search", status: "ready", enabled: true, revision: 1,
      tools: [
        { name: "secret-disabled-tool", enabled: false },
        ...Array.from({ length: 10 }, (_, i) => ({ name: `lookup-${i}`, enabled: true, approval: "allow",
          inputSchema: { type: "object", description: "x".repeat(15_000) } })),
      ],
    }), { status: 200 }));
    const output = JSON.stringify(response);
    expect(output).not.toContain("secret-disabled-tool");
    expect(output).toContain("Additional tools omitted");
    expect(output.length).toBeLessThan(65_000);
  });
});
