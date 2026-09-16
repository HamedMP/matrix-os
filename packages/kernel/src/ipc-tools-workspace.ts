/**
 * Matrix IPC Messaging, state, skills, persona, setup, and shell identity tools.
 *
 * Extracted from ./ipc-server.ts (Phase 1-A4). Pure move: no logic changes.
 * Each builder receives the shared tool factory so the SDK stays
 * dynamically imported exactly once by the composition root.
 */

import type { tool as createSdkTool } from '@anthropic-ai/claude-agent-sdk';
import type { MatrixDB } from './db.js';
import { getPersonaSuggestions, writeSetupPlan, SetupPlanSchema } from "./onboarding.js";
import { saveIdentity, deriveAiHandle } from "./identity.js";
import { loadSkillBody } from "./skills.js";
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

export function createWorkspaceTools(
  deps: IpcToolDeps,
  tool: SdkToolFactory,
) {
  const { db, homePath } = deps;
  return [
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
  ];
}
