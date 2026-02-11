/**
 * Matrix OS Agents Spike
 *
 * Tests sub-agent spawning via the `agents` option:
 * 1. Kernel receives a message, routes to a sub-agent
 * 2. Sub-agent uses MCP tools
 * 3. Kernel sees SubagentStop or result
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
    tool("complete_task", "Signal task completion with output", { task_id: z.string(), output: z.string() }, async ({ task_id, output }) => {
      store[`task:${task_id}`] = output;
      console.log(`   [MCP] complete_task("${task_id}", "${output.slice(0, 100)}")`);
      return { content: [{ type: "text" as const, text: `Task ${task_id} completed` }] };
    }),
  ],
});

const agents = {
  builder: {
    description:
      "Use this agent when the user asks to build, create, or generate an app, tool, or module. " +
      "The builder writes files and reports completion.",
    prompt:
      "You are the Matrix OS builder agent. When given a build request:\n" +
      "1. Store a key 'app:name' with the app name using set_value\n" +
      "2. Store 'app:status' as 'built' using set_value\n" +
      "3. Call complete_task with task_id 'build-1' and output describing what you built\n" +
      "Be concise. Do not use tools other than the MCP tools.",
    tools: [
      "mcp__matrix-os-ipc__set_value",
      "mcp__matrix-os-ipc__get_value",
      "mcp__matrix-os-ipc__complete_task",
    ],
    model: "haiku" as const,
    maxTurns: 10,
  },
  researcher: {
    description:
      "Use this agent for research and information gathering tasks. " +
      "The researcher finds information and reports back.",
    prompt:
      "You are the Matrix OS researcher agent. When given a research request:\n" +
      "1. Store your findings under key 'research:topic' using set_value\n" +
      "2. Call complete_task with task_id 'research-1' and your findings\n" +
      "Be concise.",
    tools: [
      "mcp__matrix-os-ipc__set_value",
      "mcp__matrix-os-ipc__complete_task",
    ],
    model: "haiku" as const,
    maxTurns: 5,
  },
};

function logMsg(msg: SDKMessage, indent = "") {
  switch (msg.type) {
    case "system":
      if ("subtype" in msg) {
        const m = msg as any;
        if (m.subtype === "init") {
          console.log(`${indent}[init] model=${m.model}, agents=[${m.agents?.join(", ") ?? "none"}]`);
          console.log(`${indent}[init] mcp=[${m.mcp_servers?.map((s: any) => `${s.name}:${s.status}`).join(", ")}]`);
        } else if (m.subtype === "task_notification") {
          console.log(`${indent}[task_notification] task=${m.task_id}, status=${m.status}`);
          console.log(`${indent}  summary: ${m.summary?.slice(0, 200)}`);
        }
      }
      break;
    case "assistant": {
      const content = (msg as any).message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === "text" && block.text.trim()) {
            console.log(`${indent}[assistant] ${block.text.slice(0, 300)}`);
          } else if (block.type === "tool_use") {
            console.log(`${indent}[tool_use] ${block.name}(${JSON.stringify(block.input).slice(0, 200)})`);
          }
        }
      }
      break;
    }
    case "result": {
      const r = msg as any;
      console.log(`${indent}[result] subtype=${r.subtype}, cost=$${r.total_cost_usd?.toFixed(4)}`);
      break;
    }
  }
}

async function main() {
  console.log("=== Agents Spike ===\n");

  console.log("[Test] Kernel with builder + researcher agents, routing to builder\n");

  const q = query({
    prompt: "Build me a simple todo app called 'my-todos'.",
    options: {
      model: "haiku",
      systemPrompt:
        "You are the Matrix OS kernel. You route requests to specialized agents.\n" +
        "For build/create requests, delegate to the 'builder' agent using the Task tool.\n" +
        "For research requests, delegate to the 'researcher' agent.\n" +
        "Be concise. Route the user's request to the appropriate agent.",
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      mcpServers: { "matrix-os-ipc": ipcServer },
      agents,
      allowedTools: [
        "Task",
        "TaskOutput",
        "mcp__matrix-os-ipc__set_value",
        "mcp__matrix-os-ipc__get_value",
        "mcp__matrix-os-ipc__complete_task",
      ],
      maxTurns: 20,
    },
  });

  let sessionId: string | undefined;
  let resultSubtype: string | undefined;

  for await (const msg of q) {
    sessionId = msg.session_id;
    logMsg(msg, "   ");
    if (msg.type === "result") resultSubtype = (msg as any).subtype;
  }

  console.log("\n=== Results ===");
  console.log(`Session:        ${sessionId ? "PASS" : "FAIL"}`);
  console.log(`Result:         ${resultSubtype === "success" ? "PASS" : "FAIL"} (${resultSubtype})`);
  console.log(`Store:          ${JSON.stringify(store)}`);
  console.log(`Agent spawned:  ${store["app:name"] || store["task:build-1"] ? "PASS (builder used MCP)" : "FAIL"}`);
  console.log(`Task completed: ${store["task:build-1"] ? "PASS" : "FAIL"}`);
}

main().catch((err) => {
  console.error("\n=== SPIKE FAILED ===");
  console.error(err.message ?? err);
  process.exit(1);
});
