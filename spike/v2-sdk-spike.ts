/**
 * Matrix OS SDK Spike
 *
 * Tests both V1 query() and V2 createSession() with:
 * 1. Custom MCP tools via createSdkMcpServer
 * 2. bypassPermissions + allowDangerouslySkipPermissions
 * 3. Custom systemPrompt
 * 4. Streaming output
 *
 * V2 types (SDKSessionOptions) don't include mcpServers/agents/systemPrompt,
 * but the docs say "Additional options supported" -- so we test if they
 * pass through at runtime despite the narrow types.
 *
 * Uses haiku to keep costs low.
 */

import {
  query,
  unstable_v2_createSession,
  createSdkMcpServer,
  tool,
  type SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod/v4";

const store: Record<string, string> = {};
let toolCallCount = 0;

function createIpcServer() {
  return createSdkMcpServer({
    name: "matrix-os-ipc",
    tools: [
      tool(
        "set_value",
        "Store a key-value pair in the Matrix OS state",
        { key: z.string(), value: z.string() },
        async ({ key, value }) => {
          store[key] = value;
          toolCallCount++;
          console.log(`   [MCP] set_value("${key}", "${value}") -- call #${toolCallCount}`);
          return { content: [{ type: "text" as const, text: `Stored: ${key} = ${value}` }] };
        }
      ),
      tool(
        "get_value",
        "Read a value from the Matrix OS state by key",
        { key: z.string() },
        async ({ key }) => {
          toolCallCount++;
          const val = store[key] ?? "(not found)";
          console.log(`   [MCP] get_value("${key}") -> "${val}" -- call #${toolCallCount}`);
          return { content: [{ type: "text" as const, text: val }] };
        }
      ),
      tool(
        "list_values",
        "List all stored key-value pairs as JSON",
        {},
        async () => {
          toolCallCount++;
          const result = JSON.stringify(store, null, 2);
          console.log(`   [MCP] list_values() -> ${result} -- call #${toolCallCount}`);
          return { content: [{ type: "text" as const, text: result }] };
        }
      ),
    ],
  });
}

const sharedOptions = {
  model: "haiku",
  systemPrompt:
    "You are a Matrix OS test agent. You have MCP tools for key-value storage. " +
    "Use them when asked. Be very concise. Do not use any other tools.",
  permissionMode: "bypassPermissions" as const,
  allowDangerouslySkipPermissions: true,
  mcpServers: {
    "matrix-os-ipc": createIpcServer(),
  },
  allowedTools: [
    "mcp__matrix-os-ipc__set_value",
    "mcp__matrix-os-ipc__get_value",
    "mcp__matrix-os-ipc__list_values",
  ],
  maxTurns: 10,
};

const PROMPT =
  "Store the value 'hello world' under key 'greeting' using set_value. " +
  "Then read it back with get_value. Be concise.";

function logMsg(msg: SDKMessage) {
  switch (msg.type) {
    case "system":
      if ("subtype" in msg && msg.subtype === "init") {
        const m = msg as any;
        console.log(`   [init] model=${m.model}, tools=[${m.tools?.join(", ")}]`);
        console.log(`   [init] mcp=[${m.mcp_servers?.map((s: any) => `${s.name}:${s.status}`).join(", ")}]`);
      }
      break;
    case "assistant": {
      const content = (msg as any).message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === "text" && block.text.trim()) {
            console.log(`   [assistant] ${block.text.slice(0, 300)}`);
          } else if (block.type === "tool_use") {
            console.log(`   [tool_use] ${block.name}(${JSON.stringify(block.input)})`);
          }
        }
      }
      break;
    }
    case "result": {
      const r = msg as any;
      console.log(`   [result] subtype=${r.subtype}, cost=$${r.total_cost_usd?.toFixed(4)}`);
      break;
    }
  }
}

// ─── Test 1: V1 query() ─────────────────────────────────────────────────────

async function testV1() {
  console.log("\n╔══════════════════════════════════════╗");
  console.log("║  Test 1: V1 query() + MCP tools      ║");
  console.log("╚══════════════════════════════════════╝\n");

  toolCallCount = 0;
  Object.keys(store).forEach((k) => delete store[k]);

  const q = query({ prompt: PROMPT, options: sharedOptions });

  let sessionId: string | undefined;
  let resultSubtype: string | undefined;

  for await (const msg of q) {
    sessionId = msg.session_id;
    logMsg(msg);
    if (msg.type === "result") resultSubtype = (msg as any).subtype;
  }

  return {
    sessionId,
    resultSubtype,
    toolCalls: toolCallCount,
    storeValue: store["greeting"],
  };
}

// ─── Test 2: V2 createSession() ─────────────────────────────────────────────

async function testV2() {
  console.log("\n╔══════════════════════════════════════╗");
  console.log("║  Test 2: V2 createSession() + MCP    ║");
  console.log("╚══════════════════════════════════════╝\n");

  toolCallCount = 0;
  Object.keys(store).forEach((k) => delete store[k]);

  // V2 types don't include mcpServers/systemPrompt/etc, but we cast to
  // test if they pass through at runtime
  const session = unstable_v2_createSession(sharedOptions as any);

  let sessionId: string | undefined;
  let resultSubtype: string | undefined;

  await session.send(PROMPT);
  for await (const msg of session.stream()) {
    sessionId = msg.session_id;
    logMsg(msg);
    if (msg.type === "result") resultSubtype = (msg as any).subtype;
  }

  // Test multi-turn: ask a follow-up
  if (resultSubtype === "success") {
    console.log("\n   --- V2 multi-turn follow-up ---");
    await session.send("Now list all stored values using list_values.");
    for await (const msg of session.stream()) {
      logMsg(msg);
      if (msg.type === "result") resultSubtype = (msg as any).subtype;
    }
  }

  session.close();

  return {
    sessionId,
    resultSubtype,
    toolCalls: toolCallCount,
    storeValue: store["greeting"],
  };
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log("=== Matrix OS SDK Spike ===");

  const test = process.argv[2] || "both";

  let v1Result: Awaited<ReturnType<typeof testV1>> | null = null;
  let v2Result: Awaited<ReturnType<typeof testV2>> | null = null;

  if (test === "v1" || test === "both") {
    v1Result = await testV1();
  }
  if (test === "v2" || test === "both") {
    v2Result = await testV2();
  }

  console.log("\n╔══════════════════════════════════════╗");
  console.log("║            RESULTS                   ║");
  console.log("╚══════════════════════════════════════╝\n");

  if (v1Result) {
    console.log("V1 query():");
    console.log(`  Session:     ${v1Result.sessionId ? "PASS" : "FAIL"}`);
    console.log(`  MCP tools:   ${v1Result.toolCalls > 0 ? "PASS" : "FAIL"} (${v1Result.toolCalls} calls)`);
    console.log(`  Store data:  ${v1Result.storeValue === "hello world" ? "PASS" : "FAIL"}`);
    console.log(`  Result:      ${v1Result.resultSubtype === "success" ? "PASS" : "FAIL"} (${v1Result.resultSubtype})`);
  }

  if (v2Result) {
    console.log("V2 createSession():");
    console.log(`  Session:     ${v2Result.sessionId ? "PASS" : "FAIL"}`);
    console.log(`  MCP tools:   ${v2Result.toolCalls > 0 ? "PASS" : "FAIL"} (${v2Result.toolCalls} calls)`);
    console.log(`  Store data:  ${v2Result.storeValue === "hello world" ? "PASS" : "FAIL"}`);
    console.log(`  Result:      ${v2Result.resultSubtype === "success" ? "PASS" : "FAIL"} (${v2Result.resultSubtype})`);
    console.log(`  Multi-turn:  ${v2Result.toolCalls > 2 ? "PASS" : "FAIL"}`);
  }

  // Recommendation
  console.log("\n=== Recommendation ===");
  if (v2Result?.resultSubtype === "success" && v2Result?.toolCalls > 2) {
    console.log("V2 works with full options! Use V2 for the kernel (cleaner multi-turn).");
    console.log("V2 send()/stream() loop maps directly to the kernel's message dispatch.");
  } else if (v1Result?.resultSubtype === "success") {
    console.log("V1 works. V2 does NOT pass through options.");
    console.log("Use V1 with streaming input for multi-turn, or resume for new turns.");
  } else {
    console.log("BOTH FAILED -- check API key and SDK version.");
  }
}

main().catch((err) => {
  console.error("\n=== SPIKE FAILED ===");
  console.error(err.message ?? err);
  if (err.stack) console.error(err.stack);
  process.exit(1);
});
