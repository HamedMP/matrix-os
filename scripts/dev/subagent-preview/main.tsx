import React from "react";
import { createRoot } from "react-dom/client";
import { ConversationSubagentActivity } from "../../../packages/ui/src/chat/subagent-activity";
import type { ChatSubagent } from "../../../packages/contracts/src/chat-subagent";
import "../../../desktop/src/renderer/src/design/index.css";

const agents: ChatSubagent[] = [
  { agentId: "research", parentAgentId: "parent", name: "Explore codebase", role: "explorer", status: "running", activity: "Searching the web", task: "Find the relevant implementation and tests." },
  { agentId: "implement", parentAgentId: "parent", name: "Implement changes", role: "worker", status: "completed", result: "Changes implemented and focused tests passed." },
  { agentId: "review", parentAgentId: "parent", name: "Review changes", role: "reviewer", status: "waiting", task: "Check correctness and surface parity." },
  { agentId: "unknown", parentAgentId: "parent", name: "Arithmetic", status: "completed", result: "437" },
  { agentId: "failed", parentAgentId: "parent", name: "Run tests", role: "worker", status: "failed", task: "Run the relevant test suite." },
];
createRoot(document.getElementById("root")!).render(<main style={{ maxWidth: 760, margin: "64px auto", padding: 24, color: "var(--text-primary)", background: "var(--bg-surface)", borderRadius: 16 }}>
  <h1 style={{ fontSize: 22, fontWeight: 500, marginBottom: 8 }}>Subagent activity</h1>
  <p style={{ color: "var(--text-secondary)", marginBottom: 28 }}>Interactive component preview · Synthetic review data</p>
  <div style={{ display: "grid", gap: 12 }}>{agents.map(agent => <ConversationSubagentActivity key={agent.agentId} agent={agent} />)}</div>
</main>);
