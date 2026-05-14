import { z } from "zod/v4";

export const WorkflowCommandSchema = z.object({
  name: z.string().trim().min(1).max(80),
  command: z.string().trim().min(1).max(500),
  ports: z.array(z.number().int().min(1).max(65_535)).max(20).optional(),
});

export const ProjectWorkflowConfigSchema = z.object({
  setupCommands: z.array(WorkflowCommandSchema).max(20).default([]),
  liveCommands: z.array(WorkflowCommandSchema).max(20).default([]),
  validationCommands: z.array(WorkflowCommandSchema).max(20).default([]),
  allowedPreviewPorts: z.array(z.number().int().min(1).max(65_535)).max(50).default([]),
  codexRequired: z.boolean().default(true),
});

export type ProjectWorkflowConfig = z.infer<typeof ProjectWorkflowConfigSchema>;

export interface ProjectWorkflowRecord extends ProjectWorkflowConfig {
  projectSlug: string;
  revision: number;
  updatedAt: string;
}

export interface CodexReadiness {
  status: "valid" | "missing" | "invalid" | "unknown";
  lastCheckedAt?: string;
}
