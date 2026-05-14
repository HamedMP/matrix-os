import type { ProjectWorkflowConfig, ProjectWorkflowRecord } from "./contracts.js";
import { join } from "node:path";
import { atomicWriteJson, readJsonFile } from "../state-ops.js";

export interface WorkflowRepository {
  get(projectSlug: string): Promise<ProjectWorkflowRecord | null>;
  save(projectSlug: string, config: ProjectWorkflowConfig): Promise<ProjectWorkflowRecord>;
}

export function createMemoryWorkflowRepository(now: () => string = () => new Date().toISOString()): WorkflowRepository {
  const records = new Map<string, ProjectWorkflowRecord>();

  return {
    async get(projectSlug) {
      return records.get(projectSlug) ?? null;
    },
    async save(projectSlug, config) {
      const previous = records.get(projectSlug);
      const record: ProjectWorkflowRecord = {
        ...config,
        projectSlug,
        revision: (previous?.revision ?? 0) + 1,
        updatedAt: now(),
      };
      records.set(projectSlug, record);
      return record;
    },
  };
}

export function createFileWorkflowRepository(options: {
  homePath: string;
  now?: () => string;
}): WorkflowRepository {
  const now = options.now ?? (() => new Date().toISOString());
  const filePath = join(options.homePath, "system", "project-workflows.json");

  async function readAll(): Promise<Record<string, ProjectWorkflowRecord>> {
    try {
      return await readJsonFile<Record<string, ProjectWorkflowRecord>>(filePath);
    } catch (err: unknown) {
      if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") {
        return {};
      }
      if (err instanceof SyntaxError) {
        console.warn("[workflow] Ignoring invalid project workflow store JSON");
        return {};
      }
      throw err;
    }
  }

  return {
    async get(projectSlug) {
      const records = await readAll();
      return records[projectSlug] ?? null;
    },
    async save(projectSlug, config) {
      const records = await readAll();
      const previous = records[projectSlug];
      const record: ProjectWorkflowRecord = {
        ...config,
        projectSlug,
        revision: (previous?.revision ?? 0) + 1,
        updatedAt: now(),
      };
      await atomicWriteJson(filePath, { ...records, [projectSlug]: record });
      return record;
    },
  };
}
