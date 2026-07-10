import {
  IsoTimestampSchema,
  ProjectIdSchema,
  TaskIdSchema,
  ThreadIdSchema,
} from "@matrix-os/contracts";
import { z } from "zod/v4";

export const CodingAgentWorkspaceViewModeSchema = z.enum(["conversation", "kanban"]);
export type CodingAgentWorkspaceViewMode = z.infer<
  typeof CodingAgentWorkspaceViewModeSchema
>;

export const CodingAgentWorkspaceResumeStateSchema = z.object({
  selectedProjectId: ProjectIdSchema.nullable(),
  selectedTaskId: TaskIdSchema.nullable(),
  selectedThreadId: ThreadIdSchema.nullable(),
  viewMode: CodingAgentWorkspaceViewModeSchema,
  updatedAt: IsoTimestampSchema,
}).strict();

export type CodingAgentWorkspaceResumeState = z.infer<
  typeof CodingAgentWorkspaceResumeStateSchema
>;

export const CodingAgentProjectWorkspaceRequestSchema = z.object({
  projectId: ProjectIdSchema,
  taskCursor: TaskIdSchema.optional(),
  taskLimit: z.number().int().min(1).max(100).optional(),
  projectThreadCursor: ThreadIdSchema.optional(),
  projectThreadLimit: z.number().int().min(1).max(100).optional(),
  taskThreadCursor: ThreadIdSchema.optional(),
  taskThreadLimit: z.number().int().min(1).max(100).optional(),
}).strict();

export type CodingAgentProjectWorkspaceRequest = z.infer<
  typeof CodingAgentProjectWorkspaceRequestSchema
>;
