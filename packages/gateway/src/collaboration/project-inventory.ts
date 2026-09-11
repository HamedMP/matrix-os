import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { z } from "zod/v4";

const CONFIRMATION_LIFETIME_MS = 10 * 60 * 1_000;
const MAX_INVENTORY_ENTRIES = 100_000;
const MAX_FILE_BYTES = 10 * 1024 * 1024 * 1024;
const MAX_TOTAL_FILE_BYTES = 100 * 1024 * 1024 * 1024;

const SafeIdSchema = z.string().min(1).max(4_096).regex(/^[^\0\r\n]+$/);
const ActorIdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
const RevisionSchema = z.union([
  z.number().int().nonnegative().transform(String),
  z.string().regex(/^(0|[1-9][0-9]{0,19})$/),
]);
const BlockerCodeSchema = z.string().min(1).max(96).regex(/^[a-z][a-z0-9_]{0,95}$/);

const ResourceRecordSchema = z.object({
  id: SafeIdSchema,
  revision: RevisionSchema,
  ownership: z.enum(["owned", "external"]).default("owned"),
  compatibility: z.enum(["ready", "blocked"]).default("ready"),
  blocker: BlockerCodeSchema.optional(),
  incarnation: z.string().min(1).max(256).regex(/^[A-Za-z0-9_-]+$/).optional(),
}).strict().superRefine((value, context) => {
  if (value.compatibility === "blocked" && !value.blocker) {
    context.addIssue({ code: "custom", message: "Blocked resources require a reason", path: ["blocker"] });
  }
  if (value.compatibility === "ready" && value.blocker) {
    context.addIssue({ code: "custom", message: "Ready resources cannot have a blocker", path: ["blocker"] });
  }
});

const ProjectRecordSchema = z.object({
  id: SafeIdSchema,
  ownerId: ActorIdSchema,
  rootPath: z.string().min(1).max(4_096),
  revision: z.number().int().nonnegative(),
}).strict();

const MembershipEffectSchema = z.object({
  actorId: ActorIdSchema,
  role: z.enum(["editor", "viewer"]),
  effect: z.enum(["join_project", "retain_item_only", "end_item_grant"]),
}).strict();

const ConfirmationPayloadSchema = z.object({
  version: z.literal(1),
  ownerId: ActorIdSchema,
  projectId: SafeIdSchema,
  projectRevision: z.number().int().nonnegative(),
  inventoryHash: z.string().regex(/^[a-f0-9]{64}$/),
  membershipHash: z.string().regex(/^[a-f0-9]{64}$/),
  expiresAt: z.iso.datetime(),
}).strict();

export type ProjectInventoryResourceRecord = z.input<typeof ResourceRecordSchema>;
export type ProjectInventoryMembershipEffect = z.infer<typeof MembershipEffectSchema>;

export interface ProjectInventoryResourceSource {
  getProject(projectId: string): Promise<z.input<typeof ProjectRecordSchema> | null>;
  listChats(projectId: string): Promise<ProjectInventoryResourceRecord[]>;
  listApps(projectId: string): Promise<ProjectInventoryResourceRecord[]>;
  getLayout(projectId: string): Promise<ProjectInventoryResourceRecord | null>;
  listTerminals(projectId: string): Promise<ProjectInventoryResourceRecord[]>;
}

export interface ProjectInventoryItem {
  kind: "file" | "chat" | "app" | "layout" | "terminal";
  id: string;
  revision: string;
  compatibility: "ready" | "blocked";
  blocker?: string;
  incarnation?: string;
  contentHash?: string;
  byteCount?: number;
}

export interface ProjectInventoryReference {
  kind: "chat" | "app" | "layout" | "terminal";
  id: string;
  revision: string;
}

export class ProjectInventoryError extends Error {
  constructor(public readonly code: "project_unavailable" | "project_changed" | "invalid_confirmation") {
    super("Project sharing inventory is unavailable");
    this.name = "ProjectInventoryError";
  }
}

interface FileSnapshot {
  path: string;
  item: ProjectInventoryItem;
  identity: FileIdentity;
}

interface FileIdentity {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}

function within(base: string, target: string): boolean {
  const path = relative(base, target);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !path.startsWith(sep));
}

function fileIdentity(stats: BigIntStats): FileIdentity {
  return {
    dev: stats.dev,
    ino: stats.ino,
    size: stats.size,
    mtimeNs: stats.mtimeNs,
    ctimeNs: stats.ctimeNs,
  };
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

async function hashFile(path: string): Promise<{ digest: string; identity: FileIdentity; byteCount: number }> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error: unknown) {
    if (error instanceof Error && ["ELOOP", "ENOENT"].includes(String((error as NodeJS.ErrnoException).code))) {
      throw new ProjectInventoryError("project_changed");
    }
    throw error;
  }
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size > BigInt(MAX_FILE_BYTES)) {
      throw new ProjectInventoryError("project_unavailable");
    }
    const hash = createHash("sha256");
    let bytes = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += value.byteLength;
      if (bytes > MAX_FILE_BYTES) throw new ProjectInventoryError("project_unavailable");
      hash.update(value);
    }
    const after = await handle.stat({ bigint: true });
    const beforeIdentity: FileIdentity = {
      dev: before.dev,
      ino: before.ino,
      size: before.size,
      mtimeNs: before.mtimeNs,
      ctimeNs: before.ctimeNs,
    };
    const afterIdentity: FileIdentity = {
      dev: after.dev,
      ino: after.ino,
      size: after.size,
      mtimeNs: after.mtimeNs,
      ctimeNs: after.ctimeNs,
    };
    if (!sameIdentity(beforeIdentity, afterIdentity) || BigInt(bytes) !== after.size) {
      throw new ProjectInventoryError("project_changed");
    }
    return { digest: hash.digest("hex"), identity: afterIdentity, byteCount: bytes };
  } finally {
    await handle.close();
  }
}

async function collectFiles(rootPath: string): Promise<{
  items: ProjectInventoryItem[];
  snapshots: FileSnapshot[];
  rootIdentity: FileIdentity;
  rootRealPath: string;
}> {
  const rootStats = await lstat(rootPath, { bigint: true });
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
    throw new ProjectInventoryError("project_unavailable");
  }
  const rootRealPath = await realpath(rootPath);
  const rootIdentity = fileIdentity(rootStats);
  const pending = [{ absolutePath: rootRealPath, relativePath: "" }];
  const items: ProjectInventoryItem[] = [];
  const snapshots: FileSnapshot[] = [];
  let totalBytes = 0;
  let entries = 0;

  while (pending.length > 0) {
    const directory = pending.pop()!;
    const handle = await opendir(directory.absolutePath);
    for await (const entry of handle) {
      entries += 1;
      if (entries > MAX_INVENTORY_ENTRIES) throw new ProjectInventoryError("project_unavailable");
      const relativePath = directory.relativePath ? `${directory.relativePath}/${entry.name}` : entry.name;
      const absolutePath = resolve(directory.absolutePath, entry.name);
      if (!within(rootRealPath, absolutePath)) throw new ProjectInventoryError("project_changed");
      const stats = await lstat(absolutePath, { bigint: true });
      if (stats.isSymbolicLink()) {
        items.push({
          kind: "file",
          id: relativePath,
          revision: "0",
          compatibility: "blocked",
          blocker: "symlink_unsupported",
        });
        continue;
      }
      if (stats.isDirectory()) {
        const directoryRealPath = await realpath(absolutePath);
        if (!within(rootRealPath, directoryRealPath)) throw new ProjectInventoryError("project_changed");
        pending.push({ absolutePath: directoryRealPath, relativePath });
        continue;
      }
      if (!stats.isFile()) {
        items.push({
          kind: "file",
          id: relativePath,
          revision: "0",
          compatibility: "blocked",
          blocker: "file_type_unsupported",
        });
        continue;
      }
      const hashed = await hashFile(absolutePath);
      totalBytes += hashed.byteCount;
      if (totalBytes > MAX_TOTAL_FILE_BYTES) throw new ProjectInventoryError("project_unavailable");
      const item: ProjectInventoryItem = {
        kind: "file",
        id: relativePath,
        revision: `${hashed.identity.mtimeNs}:${hashed.identity.size}`,
        compatibility: "ready",
        contentHash: hashed.digest,
        byteCount: hashed.byteCount,
      };
      items.push(item);
      snapshots.push({ path: absolutePath, item, identity: hashed.identity });
    }
  }
  return { items, snapshots, rootIdentity, rootRealPath };
}

async function assertUnchangedFiles(
  rootPath: string,
  rootRealPath: string,
  rootIdentity: FileIdentity,
  snapshots: readonly FileSnapshot[],
): Promise<void> {
  let currentRoot;
  try {
    currentRoot = await lstat(rootPath, { bigint: true });
  } catch (error: unknown) {
    if (error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ProjectInventoryError("project_changed");
    }
    throw error;
  }
  if (!currentRoot.isDirectory() || currentRoot.isSymbolicLink()
    || !sameIdentity(rootIdentity, fileIdentity(currentRoot))
    || await realpath(rootPath) !== rootRealPath) {
    throw new ProjectInventoryError("project_changed");
  }
  for (const snapshot of snapshots) {
    let current;
    try {
      current = await lstat(snapshot.path, { bigint: true });
    } catch (error: unknown) {
      if (error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new ProjectInventoryError("project_changed");
      }
      throw error;
    }
    if (!current.isFile() || current.isSymbolicLink()
      || !sameIdentity(snapshot.identity, fileIdentity(current))) {
      throw new ProjectInventoryError("project_changed");
    }
  }
}

function hashJson(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function sortedEffects(values: readonly ProjectInventoryMembershipEffect[]): ProjectInventoryMembershipEffect[] {
  const parsed = z.array(MembershipEffectSchema).max(7).parse(values);
  const unique = new Set(parsed.map((value) => value.actorId));
  if (unique.size !== parsed.length) throw new ProjectInventoryError("project_unavailable");
  return [...parsed].sort((left, right) => left.actorId.localeCompare(right.actorId));
}

function itemOrder(left: { kind: string; id: string }, right: { kind: string; id: string }): number {
  return left.kind.localeCompare(right.kind) || left.id.localeCompare(right.id);
}

function splitResources(
  kind: ProjectInventoryReference["kind"],
  records: readonly ProjectInventoryResourceRecord[],
  ownedItems: ProjectInventoryItem[],
  externalReferences: ProjectInventoryReference[],
): void {
  for (const raw of records) {
    const record = ResourceRecordSchema.parse(raw);
    if (record.ownership === "external") {
      externalReferences.push({ kind, id: record.id, revision: record.revision });
      continue;
    }
    const missingTerminalIncarnation = kind === "terminal" && !record.incarnation;
    ownedItems.push({
      kind,
      id: record.id,
      revision: record.revision,
      compatibility: missingTerminalIncarnation ? "blocked" : record.compatibility,
      ...(missingTerminalIncarnation
        ? { blocker: "terminal_incarnation_unavailable" }
        : record.blocker ? { blocker: record.blocker } : {}),
      ...(record.incarnation ? { incarnation: record.incarnation } : {}),
    });
  }
}

function assertUniqueResources(
  ownedItems: readonly ProjectInventoryItem[],
  externalReferences: readonly ProjectInventoryReference[],
): void {
  // The caller enforces MAX_INVENTORY_ENTRIES before allocating this set.
  const keys = new Set<string>();
  for (const item of [...ownedItems, ...externalReferences]) {
    const key = `${item.kind}\0${item.id}`;
    if (keys.has(key)) throw new ProjectInventoryError("project_unavailable");
    keys.add(key);
  }
}

function signConfirmation(payload: z.infer<typeof ConfirmationPayloadSchema>, secret: string): string {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", secret).update(encoded).digest("base64url");
  return `${encoded}.${signature}`;
}

export function createProjectInventoryService(options: {
  homePath: string;
  source: ProjectInventoryResourceSource;
  confirmationSecret: string;
  now?: () => Date;
}) {
  if (Buffer.byteLength(options.confirmationSecret) < 32) {
    throw new Error("Project inventory confirmation secret is unavailable");
  }
  const homePath = resolve(options.homePath);
  const now = options.now ?? (() => new Date());

  return {
    async preview(input: {
      ownerId: string;
      projectId: string;
      membershipEffects: readonly ProjectInventoryMembershipEffect[];
    }) {
      const ownerId = ActorIdSchema.parse(input.ownerId);
      const projectId = SafeIdSchema.parse(input.projectId);
      const effects = sortedEffects(input.membershipEffects);
      let project;
      try {
        project = ProjectRecordSchema.parse(await options.source.getProject(projectId));
      } catch (error: unknown) {
        if (!(error instanceof z.ZodError)) {
          console.warn("[collaboration-project] project inventory lookup failed", error instanceof Error ? error.name : "UnknownError");
        }
        throw new ProjectInventoryError("project_unavailable");
      }
      if (project.id !== projectId || project.ownerId !== ownerId) {
        throw new ProjectInventoryError("project_unavailable");
      }
      let realHomePath: string;
      let configuredRoot: string;
      let configuredRootIdentity: FileIdentity;
      let rootPath: string;
      try {
        realHomePath = await realpath(homePath);
        configuredRoot = resolve(project.rootPath);
        const configuredRootStats = await lstat(configuredRoot, { bigint: true });
        if (!configuredRootStats.isDirectory() || configuredRootStats.isSymbolicLink()) {
          throw new ProjectInventoryError("project_unavailable");
        }
        configuredRootIdentity = fileIdentity(configuredRootStats);
        rootPath = await realpath(configuredRoot);
      } catch (error: unknown) {
        if (error instanceof ProjectInventoryError) throw error;
        console.warn("[collaboration-project] project root unavailable", error instanceof Error ? error.name : "UnknownError");
        throw new ProjectInventoryError("project_unavailable");
      }
      if (!within(realHomePath, rootPath) || rootPath === realHomePath) {
        throw new ProjectInventoryError("project_unavailable");
      }

      try {
        const files = await collectFiles(rootPath);
        const [chats, apps, layout, terminals] = await Promise.all([
          options.source.listChats(projectId),
          options.source.listApps(projectId),
          options.source.getLayout(projectId),
          options.source.listTerminals(projectId),
        ]);
        const ownedItems = [...files.items];
        const externalReferences: ProjectInventoryReference[] = [];
        splitResources("chat", chats, ownedItems, externalReferences);
        splitResources("app", apps, ownedItems, externalReferences);
        if (layout) splitResources("layout", [layout], ownedItems, externalReferences);
        splitResources("terminal", terminals, ownedItems, externalReferences);
        if (ownedItems.length + externalReferences.length > MAX_INVENTORY_ENTRIES) {
          throw new ProjectInventoryError("project_unavailable");
        }
        assertUniqueResources(ownedItems, externalReferences);
        await assertUnchangedFiles(rootPath, files.rootRealPath, files.rootIdentity, files.snapshots);
        const currentConfiguredRoot = await lstat(configuredRoot, { bigint: true });
        if (!currentConfiguredRoot.isDirectory() || currentConfiguredRoot.isSymbolicLink()
          || !sameIdentity(configuredRootIdentity, fileIdentity(currentConfiguredRoot))
          || await realpath(configuredRoot) !== rootPath) {
          throw new ProjectInventoryError("project_changed");
        }
        const currentProject = ProjectRecordSchema.parse(await options.source.getProject(projectId));
        if (currentProject.ownerId !== ownerId || currentProject.rootPath !== project.rootPath
          || currentProject.revision !== project.revision) {
          throw new ProjectInventoryError("project_changed");
        }
        ownedItems.sort(itemOrder);
        externalReferences.sort(itemOrder);
        const blockers = ownedItems
          .filter((item): item is ProjectInventoryItem & { blocker: string } => item.compatibility === "blocked" && Boolean(item.blocker))
          .map((item) => ({ kind: item.kind, id: item.id, code: item.blocker }));
        const inventoryHash = hashJson({ projectId, projectRevision: project.revision, ownedItems, externalReferences });
        const membershipHash = hashJson(effects);
        const expiresAt = new Date(now().getTime() + CONFIRMATION_LIFETIME_MS).toISOString();
        const payload = ConfirmationPayloadSchema.parse({
          version: 1,
          ownerId,
          projectId,
          projectRevision: project.revision,
          inventoryHash,
          membershipHash,
          expiresAt,
        });
        return {
          projectId,
          projectRevision: project.revision,
          ownedItems,
          externalReferences,
          blockers,
          membershipEffects: effects,
          inventoryHash,
          membershipHash,
          inventoryToken: signConfirmation(payload, options.confirmationSecret),
          expiresAt,
        };
      } catch (error: unknown) {
        if (error instanceof ProjectInventoryError) throw error;
        if (!(error instanceof z.ZodError)) {
          console.warn("[collaboration-project] project inventory failed", error instanceof Error ? error.name : "UnknownError");
        }
        throw new ProjectInventoryError("project_unavailable");
      }
    },

    async verifyConfirmation(input: {
      ownerId: string;
      projectId: string;
      expectedRevision: number;
      inventoryHash: string;
      membershipHash: string;
      inventoryToken: string;
    }): Promise<z.infer<typeof ConfirmationPayloadSchema>> {
      const [encoded, signature, extra] = input.inventoryToken.split(".");
      if (!encoded || !signature || extra !== undefined) throw new ProjectInventoryError("invalid_confirmation");
      const expected = createHmac("sha256", options.confirmationSecret).update(encoded).digest();
      const received = Buffer.from(signature, "base64url");
      const padded = Buffer.alloc(expected.length);
      received.copy(padded, 0, 0, expected.length);
      if (received.length !== expected.length || !timingSafeEqual(expected, padded)) {
        throw new ProjectInventoryError("invalid_confirmation");
      }
      let decoded: unknown;
      try {
        decoded = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
      } catch (error: unknown) {
        if (!(error instanceof SyntaxError)) {
          console.warn("[collaboration-project] inventory confirmation decode failed", error instanceof Error ? error.name : "UnknownError");
        }
        throw new ProjectInventoryError("invalid_confirmation");
      }
      const payload = ConfirmationPayloadSchema.safeParse(decoded);
      if (!payload.success
        || payload.data.ownerId !== input.ownerId
        || payload.data.projectId !== input.projectId
        || payload.data.projectRevision !== input.expectedRevision
        || payload.data.inventoryHash !== input.inventoryHash
        || payload.data.membershipHash !== input.membershipHash
        || Date.parse(payload.data.expiresAt) <= now().getTime()) {
        throw new ProjectInventoryError("invalid_confirmation");
      }
      return payload.data;
    },
  };
}
