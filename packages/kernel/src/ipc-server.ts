import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod/v4";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
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
import { getPersonaSuggestions, writeSetupPlan, SetupPlanSchema } from "./onboarding.js";
import { saveIdentity, deriveAiHandle } from "./identity.js";

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

      tool(
        "get_persona_suggestions",
        "Get recommended apps, skills, and personality for a user role. Use during onboarding to propose a setup.",
        { role: z.string().describe("The user's role (e.g. 'student', 'developer', 'investor', or any custom role)") },
        async ({ role }) => {
          const suggestions = getPersonaSuggestions(role);
          return {
            content: [
              { type: "text" as const, text: JSON.stringify(suggestions, null, 2) },
            ],
          };
        },
      ),

      tool(
        "write_setup_plan",
        "Write the onboarding setup plan to ~/system/setup-plan.json. Call this after the user confirms the proposed setup.",
        { plan_json: z.string().describe("JSON string of the setup plan") },
        async ({ plan_json }) => {
          if (!homePath) {
            return {
              content: [
                { type: "text" as const, text: "Cannot write setup plan (no home path configured)" },
              ],
            };
          }
          try {
            const raw = JSON.parse(plan_json);
            const result = SetupPlanSchema.safeParse(raw);
            if (!result.success) {
              return {
                content: [
                  { type: "text" as const, text: `Invalid setup plan: ${result.error.message}` },
                ],
              };
            }
            writeSetupPlan(homePath, result.data);
            return {
              content: [
                { type: "text" as const, text: "Setup plan written to ~/system/setup-plan.json" },
              ],
            };
          } catch (e) {
            return {
              content: [
                { type: "text" as const, text: `Failed to write setup plan: ${e instanceof Error ? e.message : String(e)}` },
              ],
            };
          }
        },
      ),
      tool(
        "set_handle",
        "Set the user's handle (username) for their Matrix OS identity. Creates @handle:matrix-os.com and @handle_ai:matrix-os.com.",
        {
          handle: z.string().describe("The username (lowercase, no spaces, e.g. 'hamed')"),
          display_name: z.string().describe("The user's display name (e.g. 'Hamed')"),
        },
        async ({ handle, display_name }) => {
          if (!homePath) {
            return { content: [{ type: "text" as const, text: "Cannot set handle (no home path)" }] };
          }
          const cleaned = handle.toLowerCase().replace(/[^a-z0-9_-]/g, "");
          if (!cleaned) {
            return { content: [{ type: "text" as const, text: "Invalid handle. Use lowercase letters, numbers, underscores, or hyphens." }] };
          }
          saveIdentity(homePath, {
            handle: cleaned,
            aiHandle: deriveAiHandle(cleaned),
            displayName: display_name,
            createdAt: new Date().toISOString(),
          });
          return {
            content: [{
              type: "text" as const,
              text: `Handle set! You are now @${cleaned}:matrix-os.com and your AI is @${deriveAiHandle(cleaned)}:matrix-os.com`,
            }],
          };
        },
      ),

      tool(
        "manage_cron",
        "Manage scheduled cron jobs. Use 'add' to create reminders/recurring tasks, 'remove' to delete, 'list' to view all.",
        {
          action: z.enum(["add", "remove", "list"]),
          name: z.string().optional().describe("Job name (required for add)"),
          message: z.string().optional().describe("Message to deliver when job fires (required for add)"),
          schedule: z.string().optional().describe("JSON schedule object, e.g. {\"type\":\"interval\",\"intervalMs\":3600000} or {\"type\":\"cron\",\"cron\":\"0 9 * * *\"} or {\"type\":\"once\",\"at\":\"2026-03-01T09:00:00Z\"}"),
          job_id: z.string().optional().describe("Job ID (required for remove)"),
          channel: z.string().optional().describe("Target channel for delivery (telegram, discord, slack, whatsapp)"),
          chat_id: z.string().optional().describe("Target chat ID for delivery"),
        },
        async ({ action, name, message, schedule, job_id, channel, chat_id }) => {
          if (!homePath) {
            return { content: [{ type: "text" as const, text: "Cron not available (no home path)" }] };
          }
          const cronPath = join(homePath, "system", "cron.json");

          function readJobs(): unknown[] {
            if (!existsSync(cronPath)) return [];
            try { return JSON.parse(readFileSync(cronPath, "utf-8")); } catch { return []; }
          }

          function writeJobs(jobs: unknown[]) {
            writeFileSync(cronPath, JSON.stringify(jobs, null, 2) + "\n");
          }

          switch (action) {
            case "list": {
              const jobs = readJobs();
              return { content: [{ type: "text" as const, text: jobs.length > 0 ? JSON.stringify(jobs, null, 2) : "No cron jobs" }] };
            }
            case "add": {
              if (!name || !message || !schedule) {
                return { content: [{ type: "text" as const, text: "add requires name, message, and schedule" }] };
              }
              let parsed: unknown;
              try { parsed = JSON.parse(schedule); } catch {
                return { content: [{ type: "text" as const, text: "Invalid schedule JSON" }] };
              }
              const job = {
                id: `cron_${randomUUID().slice(0, 8)}`,
                name,
                message,
                schedule: parsed,
                target: channel ? { channel, chatId: chat_id } : undefined,
                createdAt: new Date().toISOString(),
              };
              const jobs = readJobs();
              jobs.push(job);
              writeJobs(jobs);
              return { content: [{ type: "text" as const, text: `Created cron job: ${job.id} (${name})` }] };
            }
            case "remove": {
              if (!job_id) {
                return { content: [{ type: "text" as const, text: "remove requires job_id" }] };
              }
              const jobs = readJobs();
              const filtered = jobs.filter((j: any) => j.id !== job_id);
              if (filtered.length === jobs.length) {
                return { content: [{ type: "text" as const, text: `Job ${job_id} not found` }] };
              }
              writeJobs(filtered);
              return { content: [{ type: "text" as const, text: `Removed cron job: ${job_id}` }] };
            }
          }
        },
      ),
    ],
  });
}
