import type { Kysely } from "kysely";
import { z } from "zod/v4";
import {
  CollaborationAuthorizationError,
  type AuthorizedCollaborationContext,
} from "./authority.js";
import type { OwnerCollaborationDatabase } from "./database.js";
import type { ProjectAdmission } from "./project-fence.js";

const MAX_RESULT_BYTES = 2 * 1024 * 1024;
const SafeIdSchema = z.string().min(1).max(256).regex(/^[A-Za-z0-9_-]+$/);
const RequestIdSchema = z.uuid();
const RelativePathSchema = z.string().min(1).max(4_096).refine(safeRelativePath);
const ReadFileSchema = z.object({ path: RelativePathSchema }).strict();
const ListFilesSchema = z.object({
  cursor: z.string().min(1).max(512).optional(),
  limit: z.number().int().min(1).max(100).default(50),
}).strict();
const SearchFilesSchema = z.object({
  query: z.string().trim().min(1).max(512),
  cursor: z.string().min(1).max(512).optional(),
  limit: z.number().int().min(1).max(100).default(50),
}).strict();
const WriteFileSchema = z.object({
  path: RelativePathSchema,
  content: z.string().refine((value) => Buffer.byteLength(value, "utf8") <= 2 * 1024 * 1024),
  expectedRevision: z.number().int().nonnegative(),
  clientRequestId: RequestIdSchema,
}).strict();
const DeleteFileSchema = WriteFileSchema.omit({ content: true });
const FileListResultSchema = z.array(z.object({ path: RelativePathSchema }).passthrough()).max(100);
const FileSearchResultSchema = z.array(z.object({
  path: RelativePathSchema,
  line: z.number().int().positive().optional(),
  preview: z.string().max(2_000).optional(),
}).passthrough()).max(100);
const InspectGitSchema = z.object({
  kind: z.enum(["status", "diff"]),
  ref: z.string().min(1).max(256).regex(/^[A-Za-z0-9._/-]+$/).refine(safeGitRef).optional(),
}).strict();
const MutateGitSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("stage"),
    paths: z.array(RelativePathSchema).min(1).max(100),
    clientRequestId: RequestIdSchema,
  }).strict(),
  z.object({
    action: z.literal("commit"),
    message: z.string().trim().min(1).max(2_000),
    clientRequestId: RequestIdSchema,
  }).strict(),
  z.object({
    action: z.literal("create_branch"),
    branch: z.string().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/).refine(safeGitRef),
    clientRequestId: RequestIdSchema,
  }).strict(),
]);
const InspectAgentSchema = z.object({ agentId: SafeIdSchema }).strict();
const StartAgentSchema = z.object({
  agentId: SafeIdSchema,
  prompt: z.string().min(1).refine((value) => Buffer.byteLength(value, "utf8") <= 64 * 1024),
  clientRequestId: RequestIdSchema,
}).strict();
const ExportSchema = z.object({ clientRequestId: RequestIdSchema }).strict();

type ReadFileInput = z.infer<typeof ReadFileSchema>;
type ListFilesInput = z.infer<typeof ListFilesSchema>;
type SearchFilesInput = z.infer<typeof SearchFilesSchema>;
type WriteFileInput = z.infer<typeof WriteFileSchema>;
type DeleteFileInput = z.infer<typeof DeleteFileSchema>;
type InspectGitInput = z.infer<typeof InspectGitSchema>;
type MutateGitInput = z.infer<typeof MutateGitSchema>;
type InspectAgentInput = z.infer<typeof InspectAgentSchema>;
type StartAgentInput = z.infer<typeof StartAgentSchema>;
type ExportInput = z.infer<typeof ExportSchema>;

export interface ProjectResourceContext {
  scopeId: string;
  actorId: string;
  ownerId: string;
  projectId: string;
  role: "owner" | "editor" | "viewer";
  authEpoch: number;
  authorityRuntimeId: string;
  authorityGeneration: number;
}

export class ProjectResourceAdapterError extends Error {
  constructor(public readonly code: "invalid" | "not_found" | "forbidden" | "conflict" | "unavailable") {
    super("Shared project resource is unavailable");
    this.name = "ProjectResourceAdapterError";
  }
}

function safeRelativePath(value: string): boolean {
  if (Buffer.byteLength(value, "utf8") > 4_096 || value.startsWith("/") || value.includes("\\") || value.includes("\0")) return false;
  return value.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

function safeGitRef(value: string): boolean {
  return !value.startsWith("/") && !value.endsWith("/") && !value.endsWith(".")
    && !value.includes("..") && !value.includes("//") && !value.includes("@{")
    && !value.split("/").some((segment) => segment.startsWith(".") || segment.endsWith(".lock"));
}

function boundedResult<T>(value: T): T {
  const parsed = z.json().safeParse(value);
  if (!parsed.success || Buffer.byteLength(JSON.stringify(parsed.data), "utf8") > MAX_RESULT_BYTES) {
    throw new ProjectResourceAdapterError("unavailable");
  }
  return parsed.data as T;
}

function driverContext(context: AuthorizedCollaborationContext): ProjectResourceContext {
  return {
    scopeId: context.scopeId,
    actorId: context.actorId,
    ownerId: context.ownerId,
    projectId: context.resourceId,
    role: context.role,
    authEpoch: context.authEpoch,
    authorityRuntimeId: context.authorityRuntimeId,
    authorityGeneration: context.authorityGeneration,
  };
}

function mapError(error: unknown): ProjectResourceAdapterError {
  if (error instanceof ProjectResourceAdapterError) return error;
  if (error instanceof CollaborationAuthorizationError) {
    return new ProjectResourceAdapterError(error.code === "forbidden" ? "forbidden" : error.code === "not_found" ? "not_found" : "unavailable");
  }
  console.warn("[collaboration-project] scoped resource operation failed", error instanceof Error ? error.name : "UnknownError");
  return new ProjectResourceAdapterError("unavailable");
}

export function createProjectResourceAdapters(options: {
  db: Kysely<OwnerCollaborationDatabase>;
  authority: {
    authorize(input: {
      scopeId: string;
      actorId: string;
      action: "read" | "mutate_project" | "export_project";
    }): Promise<AuthorizedCollaborationContext>;
  };
  projectFence: {
    withAdmission<T>(input: {
      projectScopeId: string;
      ownerId: string;
      projectId: string;
      authorityRuntimeId: string;
      authorityGeneration: number;
      kind: "write" | "run";
      path: "scoped";
    }, operation: (admission: ProjectAdmission) => Promise<T>): Promise<T>;
  };
  files: {
    read(context: ProjectResourceContext, input: ReadFileInput): Promise<unknown>;
    list(context: ProjectResourceContext, input: ListFilesInput): Promise<unknown>;
    search(context: ProjectResourceContext, input: SearchFilesInput): Promise<unknown>;
    write(context: ProjectResourceContext, input: WriteFileInput): Promise<unknown>;
    delete(context: ProjectResourceContext, input: DeleteFileInput): Promise<unknown>;
  };
  git: {
    inspect(context: ProjectResourceContext, input: InspectGitInput): Promise<unknown>;
    mutate(context: ProjectResourceContext, input: MutateGitInput): Promise<unknown>;
  };
  agents: {
    collaborationMode: "scoped" | "unavailable";
    inspect(context: ProjectResourceContext, input: InspectAgentInput): Promise<unknown>;
    start(context: ProjectResourceContext, input: StartAgentInput): Promise<unknown>;
  };
  apps: {
    query(context: AuthorizedCollaborationContext, input: { appId: string; action: unknown }): Promise<unknown>;
    mutate(context: AuthorizedCollaborationContext, input: unknown): Promise<unknown>;
  };
  layout: {
    get(context: AuthorizedCollaborationContext, input: { canvasId: string }): Promise<unknown>;
    patchNode(context: AuthorizedCollaborationContext, input: unknown): Promise<unknown>;
    putViewState(context: AuthorizedCollaborationContext, input: unknown): Promise<unknown>;
  };
  exports: {
    create(context: ProjectResourceContext, input: ExportInput): Promise<unknown>;
  };
}) {
  async function current(
    original: AuthorizedCollaborationContext,
    action: "read" | "mutate_project" | "export_project",
  ): Promise<AuthorizedCollaborationContext> {
    if (original.resourceKind !== "project" || original.scopeId !== original.membershipScopeId) {
      throw new ProjectResourceAdapterError("not_found");
    }
    const authorized = await options.authority.authorize({
      scopeId: original.scopeId,
      actorId: original.actorId,
      action,
    });
    if (authorized.resourceKind !== "project" || authorized.resourceId !== original.resourceId
      || authorized.ownerId !== original.ownerId || authorized.scopeId !== original.scopeId
      || authorized.authorityRuntimeId !== original.authorityRuntimeId
      || authorized.authorityGeneration !== original.authorityGeneration) {
      throw new ProjectResourceAdapterError("not_found");
    }
    return authorized;
  }

  async function fileBinding(context: AuthorizedCollaborationContext, path: string): Promise<void> {
    const binding = await options.db.selectFrom("collaboration_resource_bindings")
      .select(["readiness", "authority_runtime_id", "authority_generation"])
      .where("project_scope_id", "=", context.scopeId)
      .where("resource_kind", "=", "file")
      .where("resource_id", "=", path)
      .executeTakeFirst();
    if (!binding) throw new ProjectResourceAdapterError("not_found");
    if (binding.readiness !== "ready" || binding.authority_runtime_id !== context.authorityRuntimeId
      || Number(binding.authority_generation) !== context.authorityGeneration) {
      throw new ProjectResourceAdapterError("unavailable");
    }
  }

  async function validateListedFiles(context: AuthorizedCollaborationContext, raw: unknown, search: boolean): Promise<unknown[]> {
    const values = search ? FileSearchResultSchema.safeParse(raw) : FileListResultSchema.safeParse(raw);
    if (!values.success) throw new ProjectResourceAdapterError("unavailable");
    for (const value of values.data) await fileBinding(context, value.path);
    return values.data;
  }

  async function fenced<T>(context: AuthorizedCollaborationContext, kind: "write" | "run", operation: () => Promise<T>): Promise<T> {
    return options.projectFence.withAdmission({
      projectScopeId: context.scopeId,
      ownerId: context.ownerId,
      projectId: context.resourceId,
      authorityRuntimeId: context.authorityRuntimeId,
      authorityGeneration: context.authorityGeneration,
      kind,
      path: "scoped",
    }, operation);
  }

  async function readFile(context: AuthorizedCollaborationContext, raw: unknown) {
    const input = ReadFileSchema.safeParse(raw);
    if (!input.success) throw new ProjectResourceAdapterError("invalid");
    try {
      const authorized = await current(context, "read");
      await fileBinding(authorized, input.data.path);
      return boundedResult(await options.files.read(driverContext(authorized), input.data));
    } catch (error: unknown) { throw mapError(error); }
  }

  async function listFiles(context: AuthorizedCollaborationContext, raw: unknown) {
    const input = ListFilesSchema.safeParse(raw);
    if (!input.success) throw new ProjectResourceAdapterError("invalid");
    try {
      const authorized = await current(context, "read");
      return validateListedFiles(authorized, await options.files.list(driverContext(authorized), input.data), false);
    } catch (error: unknown) { throw mapError(error); }
  }

  async function searchFiles(context: AuthorizedCollaborationContext, raw: unknown) {
    const input = SearchFilesSchema.safeParse(raw);
    if (!input.success) throw new ProjectResourceAdapterError("invalid");
    try {
      const authorized = await current(context, "read");
      return validateListedFiles(authorized, await options.files.search(driverContext(authorized), input.data), true);
    } catch (error: unknown) { throw mapError(error); }
  }

  async function writeFile(context: AuthorizedCollaborationContext, raw: unknown) {
    const input = WriteFileSchema.safeParse(raw);
    if (!input.success) throw new ProjectResourceAdapterError("invalid");
    try {
      const authorized = await current(context, "mutate_project");
      await fileBinding(authorized, input.data.path);
      return boundedResult(await fenced(authorized, "write", () => options.files.write(driverContext(authorized), input.data)));
    } catch (error: unknown) { throw mapError(error); }
  }

  async function deleteFile(context: AuthorizedCollaborationContext, raw: unknown) {
    const input = DeleteFileSchema.safeParse(raw);
    if (!input.success) throw new ProjectResourceAdapterError("invalid");
    try {
      const authorized = await current(context, "mutate_project");
      await fileBinding(authorized, input.data.path);
      return boundedResult(await fenced(authorized, "write", () => options.files.delete(driverContext(authorized), input.data)));
    } catch (error: unknown) { throw mapError(error); }
  }

  async function inspectGit(context: AuthorizedCollaborationContext, raw: unknown) {
    const input = InspectGitSchema.safeParse(raw);
    if (!input.success) throw new ProjectResourceAdapterError("invalid");
    try {
      const authorized = await current(context, "read");
      return boundedResult(await options.git.inspect(driverContext(authorized), input.data));
    } catch (error: unknown) { throw mapError(error); }
  }

  async function mutateGit(context: AuthorizedCollaborationContext, raw: unknown) {
    const input = MutateGitSchema.safeParse(raw);
    if (!input.success) throw new ProjectResourceAdapterError("invalid");
    try {
      const authorized = await current(context, "mutate_project");
      if (input.data.action === "stage") {
        for (const path of input.data.paths) await fileBinding(authorized, path);
      }
      return boundedResult(await fenced(authorized, "write", () => options.git.mutate(driverContext(authorized), input.data)));
    } catch (error: unknown) { throw mapError(error); }
  }

  async function inspectAgent(context: AuthorizedCollaborationContext, raw: unknown) {
    const input = InspectAgentSchema.safeParse(raw);
    if (!input.success) throw new ProjectResourceAdapterError("invalid");
    try {
      const authorized = await current(context, "read");
      return boundedResult(await options.agents.inspect(driverContext(authorized), input.data));
    } catch (error: unknown) { throw mapError(error); }
  }

  async function startAgent(context: AuthorizedCollaborationContext, raw: unknown) {
    const input = StartAgentSchema.safeParse(raw);
    if (!input.success) throw new ProjectResourceAdapterError("invalid");
    try {
      const authorized = await current(context, "mutate_project");
      if (options.agents.collaborationMode !== "scoped") {
        throw new ProjectResourceAdapterError("unavailable");
      }
      return boundedResult(await fenced(authorized, "run", () => options.agents.start(driverContext(authorized), input.data)));
    } catch (error: unknown) { throw mapError(error); }
  }

  async function queryApp(context: AuthorizedCollaborationContext, input: { appId: string; action: unknown }) {
    try {
      const authorized = await current(context, "read");
      return boundedResult(await options.apps.query(authorized, input));
    } catch (error: unknown) { throw mapError(error); }
  }

  async function mutateApp(context: AuthorizedCollaborationContext, input: unknown) {
    try {
      const authorized = await current(context, "mutate_project");
      return boundedResult(await fenced(authorized, "write", () => options.apps.mutate(authorized, input)));
    } catch (error: unknown) { throw mapError(error); }
  }

  async function getLayout(context: AuthorizedCollaborationContext, input: { canvasId: string }) {
    try {
      const authorized = await current(context, "read");
      return boundedResult(await options.layout.get(authorized, input));
    } catch (error: unknown) { throw mapError(error); }
  }

  async function patchLayout(context: AuthorizedCollaborationContext, input: unknown) {
    try {
      const authorized = await current(context, "mutate_project");
      return boundedResult(await fenced(authorized, "write", () => options.layout.patchNode(authorized, input)));
    } catch (error: unknown) { throw mapError(error); }
  }

  async function putLayoutViewState(context: AuthorizedCollaborationContext, input: unknown) {
    try {
      const authorized = await current(context, "read");
      return boundedResult(await options.layout.putViewState(authorized, input));
    } catch (error: unknown) { throw mapError(error); }
  }

  async function createExport(context: AuthorizedCollaborationContext, raw: unknown) {
    const input = ExportSchema.safeParse(raw);
    if (!input.success) throw new ProjectResourceAdapterError("invalid");
    try {
      const authorized = await current(context, "export_project");
      return boundedResult(await options.exports.create(driverContext(authorized), input.data));
    } catch (error: unknown) { throw mapError(error); }
  }

  return {
    readFile,
    listFiles,
    searchFiles,
    writeFile,
    deleteFile,
    inspectGit,
    mutateGit,
    inspectAgent,
    startAgent,
    queryApp,
    mutateApp,
    getLayout,
    patchLayout,
    putLayoutViewState,
    createExport,
  };
}
