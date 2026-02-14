import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod/v4";
import type { MatrixDB } from "./db.js";
import {
  listTasks,
  claimTask,
  completeTask,
  failTask,
  sendMessage,
  readMessages,
  readState,
  createTask,
} from "./ipc.js";
import { loadSkillBody } from "./skills.js";

export function createIpcServer(db: MatrixDB, homePath?: string) {
  return createSdkMcpServer({
    name: "matrix-os-ipc",
    tools: [
      tool(
        "list_tasks",
        "List tasks, optionally filtered by status or assignee",
        {
          status: z
            .enum(["pending", "in_progress", "completed", "failed"])
            .optional(),
          assigned_to: z.string().optional(),
        },
        async ({ status, assigned_to }) => {
          const result = listTasks(db, {
            status,
            assignedTo: assigned_to,
          });
          return {
            content: [
              { type: "text" as const, text: JSON.stringify(result, null, 2) },
            ],
          };
        },
      ),

      tool(
        "create_task",
        "Create a new task for an agent to work on",
        {
          type: z.string(),
          input: z.string(),
          priority: z.number().optional(),
        },
        async ({ type, input, priority }) => {
          const id = createTask(db, {
            type,
            input: JSON.parse(input),
            priority,
          });
          return {
            content: [
              { type: "text" as const, text: `Created task: ${id}` },
            ],
          };
        },
      ),

      tool(
        "claim_task",
        "Claim an unassigned pending task for this agent",
        { task_id: z.string() },
        async ({ task_id }) => {
          const result = claimTask(db, task_id, "agent");
          return {
            content: [
              {
                type: "text" as const,
                text: result.success
                  ? `Claimed task ${task_id}`
                  : `Failed to claim task ${task_id} (already claimed or not found)`,
              },
            ],
          };
        },
      ),

      tool(
        "complete_task",
        "Mark a task as completed with output",
        { task_id: z.string(), output: z.string() },
        async ({ task_id, output }) => {
          const result = completeTask(db, task_id, JSON.parse(output));
          return {
            content: [
              {
                type: "text" as const,
                text: result.success
                  ? `Completed task ${task_id}`
                  : `Failed to complete task ${task_id}`,
              },
            ],
          };
        },
      ),

      tool(
        "fail_task",
        "Mark a task as failed with error details",
        { task_id: z.string(), error: z.string() },
        async ({ task_id, error }) => {
          const result = failTask(db, task_id, error);
          return {
            content: [
              {
                type: "text" as const,
                text: result.success
                  ? `Failed task ${task_id}`
                  : `Task ${task_id} not found`,
              },
            ],
          };
        },
      ),

      tool(
        "send_message",
        "Send a message to another agent or the kernel",
        { to: z.string(), content: z.string() },
        async ({ to, content }) => {
          sendMessage(db, { from: "agent", to, content });
          return {
            content: [
              { type: "text" as const, text: `Message sent to ${to}` },
            ],
          };
        },
      ),

      tool(
        "read_messages",
        "Read unread messages for this agent",
        {},
        async () => {
          const msgs = readMessages(db, "agent");
          return {
            content: [
              {
                type: "text" as const,
                text:
                  msgs.length > 0
                    ? JSON.stringify(msgs, null, 2)
                    : "No unread messages",
              },
            ],
          };
        },
      ),

      tool("read_state", "Read the current Matrix OS state summary", {}, async () => {
        const state = readState(db);
        return {
          content: [{ type: "text" as const, text: state }],
        };
      }),

      tool(
        "load_skill",
        "Load the full instructions for a skill by name. Use this when a user request matches a skill's triggers.",
        { skill_name: z.string() },
        async ({ skill_name }) => {
          if (!homePath) {
            return {
              content: [
                { type: "text" as const, text: "Skills not available (no home path configured)" },
              ],
            };
          }
          const body = loadSkillBody(homePath, skill_name);
          return {
            content: [
              {
                type: "text" as const,
                text: body ?? `Skill "${skill_name}" not found`,
              },
            ],
          };
        },
      ),
    ],
  });
}
