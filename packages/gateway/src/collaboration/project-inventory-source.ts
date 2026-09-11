import { relative, resolve, sep } from "node:path";
import { z } from "zod/v4";
import type {
  ProjectInventoryResourceRecord,
  ProjectInventoryResourceSource,
} from "./project-inventory.js";

const ActorIdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
const ResourceIdSchema = z.string().min(1).max(256).regex(/^[A-Za-z0-9_.:-]+$/);
const ProjectRecordSchema = z.object({
  id: ResourceIdSchema,
  ownerId: ActorIdSchema,
  rootPath: z.string().min(1).max(4_096),
  updatedAt: z.iso.datetime(),
}).strict();
const ChatRecordSchema = z.object({
  id: ResourceIdSchema,
  revision: z.number().int().nonnegative(),
}).strict();
const CanvasRecordSchema = z.object({
  id: ResourceIdSchema,
  revision: z.number().int().nonnegative(),
  nodes: z.array(z.object({
    type: z.string().min(1).max(80),
    sourceRef: z.object({
      kind: z.string().min(1).max(80),
      id: ResourceIdSchema,
      projectId: ResourceIdSchema.optional(),
    }).passthrough().nullable(),
  }).passthrough()).max(500),
}).strict();
const AppRecordSchema = z.object({
  id: ResourceIdSchema,
  collaborationMode: z.enum(["scoped", "unavailable"]),
}).strict();
const SessionRecordSchema = z.object({
  name: ResourceIdSchema,
  canonicalName: ResourceIdSchema,
  cwd: z.string().min(1).max(4_096).optional(),
  updatedAt: z.iso.datetime(),
  sessionIncarnation: z.string().regex(/^terminal-[a-f0-9]{32}$/).optional(),
  incarnationVerified: z.boolean(),
  sharedControlMode: z.enum(["eligible", "shared"]).optional(),
}).passthrough();

export class GatewayProjectInventorySourceError extends Error {
  constructor(public readonly code: "unavailable") {
    super("Project inventory source is unavailable");
    this.name = "GatewayProjectInventorySourceError";
  }
}

interface Dependencies {
  homePath: string;
  projects: {
    get(ownerId: string, projectId: string): Promise<unknown>;
  };
  chats: {
    list(ownerId: string, projectId: string): Promise<unknown[]>;
  };
  canvases: {
    getProjectCanvas(ownerId: string, projectId: string): Promise<unknown | null>;
  };
  apps: {
    get(appId: string): Promise<unknown | null>;
  };
  sessions: {
    list(): Promise<unknown[]>;
  };
}

function unavailable(error: unknown): never {
  if (!(error instanceof z.ZodError)) {
    console.warn("[collaboration-project] canonical inventory source failed", error instanceof Error ? error.name : "UnknownError");
  }
  throw new GatewayProjectInventorySourceError("unavailable");
}

function within(base: string, target: string): boolean {
  const path = relative(base, target);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !path.startsWith(sep));
}

function revision(value: string): string {
  const parsed = Date.parse(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new GatewayProjectInventorySourceError("unavailable");
  return String(parsed);
}

export function createGatewayProjectInventorySource(
  options: Dependencies,
): ProjectInventoryResourceSource {
  const homePath = resolve(options.homePath);

  async function project(ownerId: string, projectId: string) {
    const owner = ActorIdSchema.parse(ownerId);
    const id = ResourceIdSchema.parse(projectId);
    const value = await options.projects.get(owner, id);
    if (value === null) return null;
    const parsed = ProjectRecordSchema.parse(value);
    if (parsed.id !== id || parsed.ownerId !== owner) return null;
    return parsed;
  }

  async function canvas(ownerId: string, projectId: string) {
    const value = await options.canvases.getProjectCanvas(
      ActorIdSchema.parse(ownerId),
      ResourceIdSchema.parse(projectId),
    );
    return value === null ? null : CanvasRecordSchema.parse(value);
  }

  return {
    async getProject(ownerId, projectId) {
      try {
        const record = await project(ownerId, projectId);
        if (!record) return null;
        return {
          id: record.id,
          ownerId: record.ownerId,
          rootPath: record.rootPath,
          revision: Number(revision(record.updatedAt)),
        };
      } catch (error: unknown) {
        return unavailable(error);
      }
    },

    async listChats(ownerId, projectId) {
      try {
        ActorIdSchema.parse(ownerId);
        ResourceIdSchema.parse(projectId);
        const records = z.array(ChatRecordSchema).max(100_000)
          .parse(await options.chats.list(ownerId, projectId));
        return records.map((record) => ({
          id: record.id,
          revision: String(record.revision),
          compatibility: "ready" as const,
        }));
      } catch (error: unknown) {
        return unavailable(error);
      }
    },

    async listApps(ownerId, projectId) {
      try {
        const record = await canvas(ownerId, projectId);
        if (!record) return [];
        const resources = new Map<string, ProjectInventoryResourceRecord>();
        for (const node of record.nodes) {
          if (node.type !== "app_window" || node.sourceRef?.kind !== "app_window") continue;
          const id = node.sourceRef.id;
          if (node.sourceRef.projectId !== projectId) {
            if (!resources.has(id)) resources.set(id, { id, revision: String(record.revision), ownership: "external" });
            continue;
          }
          const app = AppRecordSchema.safeParse(await options.apps.get(id));
          resources.set(id, {
            id,
            revision: String(record.revision),
            compatibility: app.success && app.data.id === id && app.data.collaborationMode === "scoped"
              ? "ready"
              : "blocked",
            ...(!(app.success && app.data.id === id && app.data.collaborationMode === "scoped")
              ? { blocker: "role_enforcement_unavailable" }
              : {}),
          });
        }
        return [...resources.values()].sort((left, right) => left.id.localeCompare(right.id));
      } catch (error: unknown) {
        return unavailable(error);
      }
    },

    async getLayout(ownerId, projectId) {
      try {
        const record = await canvas(ownerId, projectId);
        return record ? { id: record.id, revision: String(record.revision), compatibility: "ready" } : null;
      } catch (error: unknown) {
        return unavailable(error);
      }
    },

    async listTerminals(ownerId, projectId) {
      try {
        const [projectRecord, canvasRecord, sessions] = await Promise.all([
          project(ownerId, projectId),
          canvas(ownerId, projectId),
          options.sessions.list().then((values) => z.array(SessionRecordSchema).max(10_000).parse(values)),
        ]);
        if (!projectRecord) throw new GatewayProjectInventorySourceError("unavailable");
        if (!canvasRecord) return [];
        const byName = new Map(sessions.flatMap((session) => [
          [session.name, session] as const,
          [session.canonicalName, session] as const,
        ]));
        const resources = new Map<string, ProjectInventoryResourceRecord>();
        for (const node of canvasRecord.nodes) {
          if (node.sourceRef?.kind !== "terminal_session") continue;
          const id = node.sourceRef.id;
          const session = byName.get(id);
          const resourceRevision = session ? revision(session.updatedAt) : "0";
          if (node.sourceRef.projectId !== projectId) {
            if (!resources.has(id)) resources.set(id, { id, revision: resourceRevision, ownership: "external" });
            continue;
          }
          const cwd = session?.cwd && session.cwd !== "~" ? resolve(homePath, session.cwd) : homePath;
          const safe = Boolean(session
            && within(resolve(projectRecord.rootPath), cwd)
            && session.incarnationVerified
            && session.sharedControlMode
            && session.sessionIncarnation);
          resources.set(id, {
            id,
            revision: resourceRevision,
            compatibility: safe ? "ready" : "blocked",
            ...(!safe ? {
              blocker: session?.sessionIncarnation
                ? "terminal_isolation_unavailable"
                : "terminal_incarnation_unavailable",
            } : {}),
            ...(session?.sessionIncarnation ? { incarnation: session.sessionIncarnation } : {}),
          });
        }
        return [...resources.values()].sort((left, right) => left.id.localeCompare(right.id));
      } catch (error: unknown) {
        return unavailable(error);
      }
    },
  };
}
