/**
 * Matrix OS Multi-Turn Spike
 *
 * Tests V1 query() with resume for multi-turn conversations.
 * This is the kernel pattern: each user message = separate query() with resume.
 *
 * Uses haiku to keep costs low.
 */

import { query, createSdkMcpServer, tool, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod/v4";

const store: Record<string, string> = {};

const ipcServer = createSdkMcpServer({
  name: "matrix-os-ipc",
  tools: [
    tool("set_value", "Store a key-value pair", { key: z.string(), value: z.string() }, async ({ key, value }) => {
      store[key] = value;
      console.log(`   [MCP] set_value("${key}", "${value}")`);
      return { content: [{ type: "text" as const, text: `Stored: ${key} = ${value}` }] };
    }),
    tool("get_value", "Read a value by key", { key: z.string() }, async ({ key }) => {
      const val = store[key] ?? "(not found)";
      console.log(`   [MCP] get_value("${key}") -> "${val}"`);
      return { content: [{ type: "text" as const, text: val }] };
    }),
    tool("list_values", "List all stored pairs", {}, async () => {
      console.log(`   [MCP] list_values()`);
      return { content: [{ type: "text" as const, text: JSON.stringify(store, null, 2) }] };
    }),
  ],
});

const baseOptions = {
  model: "haiku",
  systemPrompt:
    "You are a Matrix OS kernel agent. You have MCP tools for state management. " +
    "Use set_value, get_value, list_values when asked. Be very concise.",
  permissionMode: "bypassPermissions" as const,
  allowDangerouslySkipPermissions: true,
  mcpServers: { "matrix-os-ipc": ipcServer },
  allowedTools: [
    "mcp__matrix-os-ipc__set_value",
    "mcp__matrix-os-ipc__get_value",
    "mcp__matrix-os-ipc__list_values",
  ],
  maxTurns: 10,
};

function getAssistantText(msg: SDKMessage): string | null {
  if (msg.type !== "assistant") return null;
  const content = (msg as any).message?.content;
  if (!Array.isArray(content)) return null;
  return content
    .filter((b: any) => b.type === "text")
    .map((b: any) => b.text)
    .join("");
}

/** Simulate one kernel turn: send a message, stream response, return session ID */
async function kernelTurn(
  message: string,
  sessionId?: string
): Promise<{ sessionId: string; cost: number }> {
  const options = sessionId ? { ...baseOptions, resume: sessionId } : baseOptions;
  const q = query({ prompt: message, options });

  let sid: string | undefined;
  let cost = 0;

  for await (const msg of q) {
    sid = msg.session_id;

    if (msg.type === "assistant") {
      const text = getAssistantText(msg);
      if (text?.trim()) console.log(`   [kernel] ${text.slice(0, 300)}`);

      // Log tool uses
      const content = (msg as any).message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === "tool_use") {
            console.log(`   [tool_use] ${block.name}(${JSON.stringify(block.input)})`);
          }
        }
      }
    }
    if (msg.type === "result") {
      cost = (msg as any).total_cost_usd ?? 0;
    }
  }

  return { sessionId: sid!, cost };
}

async function main() {
  console.log("=== Multi-Turn Spike (V1 query + resume) ===\n");

  // Turn 1: Store a value
  console.log("[Turn 1] User: Store 'matrix-os' under key 'project'");
  const turn1 = await kernelTurn("Store 'matrix-os' under key 'project' using set_value. Confirm.");
  console.log(`   cost=$${turn1.cost.toFixed(4)}, session=${turn1.sessionId.slice(0, 8)}...\n`);

  // Turn 2: Resume and ask a follow-up (tests context persistence)
  console.log("[Turn 2] User: What project are we working on? (read it back)");
  const turn2 = await kernelTurn(
    "What value is stored under 'project'? Use get_value to check.",
    turn1.sessionId
  );
  console.log(`   cost=$${turn2.cost.toFixed(4)}, session=${turn2.sessionId.slice(0, 8)}...\n`);

  // Turn 3: Another follow-up
  console.log("[Turn 3] User: Store another value and list everything");
  const turn3 = await kernelTurn(
    "Store 'v0.1' under key 'version', then list_values to show everything.",
    turn2.sessionId
  );
  console.log(`   cost=$${turn3.cost.toFixed(4)}, session=${turn3.sessionId.slice(0, 8)}...\n`);

  // Results
  console.log("=== Results ===");
  console.log(`Store: ${JSON.stringify(store)}`);
  console.log(`Sessions: ${turn1.sessionId === turn2.sessionId ? "SAME (context preserved)" : "DIFFERENT"}`);
  console.log(`Total cost: $${(turn1.cost + turn2.cost + turn3.cost).toFixed(4)}`);

  const pass =
    store["project"] === "matrix-os" &&
    store["version"] === "v0.1" &&
    turn1.sessionId === turn2.sessionId;

  console.log(`\nMulti-turn + MCP: ${pass ? "PASS" : "FAIL"}`);
  console.log("Kernel pattern: query() per turn with resume = clean multi-turn with full options.");
}

main().catch((err) => {
  console.error("\n=== SPIKE FAILED ===");
  console.error(err.message ?? err);
  process.exit(1);
});
