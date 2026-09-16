/**
 * Matrix IPC Task list management tools.
 *
 * Extracted from ./ipc-server.ts (Phase 1-A4). Pure move: no logic changes.
 * Each builder receives the shared tool factory so the SDK stays
 * dynamically imported exactly once by the composition root.
 */

import type { tool as createSdkTool } from '@anthropic-ai/claude-agent-sdk';
import type { MatrixDB } from './db.js';
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
import { z } from "zod/v4";

export interface IpcToolDeps {
  db: MatrixDB;
  homePath?: string;
}

type SdkToolFactory = typeof createSdkTool;

export function createTasksTools(
  deps: IpcToolDeps,
  tool: SdkToolFactory,
) {
  const { db, homePath } = deps;
  return [
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
  ];
}
