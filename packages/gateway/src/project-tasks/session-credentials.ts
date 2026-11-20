import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, link, lstat, mkdir, open, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod/v4";
import { ProjectIdSchema, TaskIdSchema } from "@matrix-os/contracts/project-tasks";

/**
 * The credential a task terminal tab gets at launch (spec 2699 section 5): an HMAC over
 * the tab, its project and its task, keyed with an owner-only secret. The board binds a
 * local-token caller only from a credential it verifies, never from caller-named panes.
 */
export const TASK_SESSION_SECRET_RELATIVE_PATH = join(".cache", "matrix", "task-session.key");

const SEGMENT = /^[A-Za-z0-9_-]{1,128}$/;
const SECRET = /^[a-f0-9]{64}$/;
const VERSION = "mts1";
const MAX_TOKEN_LENGTH = 700;
const MAC_LENGTH = 43;

const MaterialSchema = z.object({
  workspaceId: z.string().regex(SEGMENT),
  tabId: z.string().regex(SEGMENT),
  projectId: ProjectIdSchema,
  taskId: TaskIdSchema,
});
export type TaskSessionMaterial = z.infer<typeof MaterialSchema>;

export interface TaskSessionCredentials {
  issue(material: TaskSessionMaterial): Promise<string>;
  /** The signed material, or null for anything this owner's secret did not sign. Throws when the secret is unusable. */
  verify(token: string): Promise<TaskSessionMaterial | null>;
}

function mac(secret: Buffer, payload: string): string {
  return createHmac("sha256", secret).update(`matrix-task-session:${payload}`).digest("base64url");
}

async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("task session secret directory is not a directory");
  if ((info.mode & 0o077) !== 0) await chmod(path, 0o700);
}

async function readSecret(file: string): Promise<Buffer> {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 || info.size > 128) {
    throw new Error("task session secret is not an owner-only file");
  }
  const text = (await readFile(file, "utf8")).trim();
  if (!SECRET.test(text)) throw new Error("task session secret is malformed");
  return Buffer.from(text, "hex");
}

/** Reads the secret, creating it on first use: an exclusive temp file linked into place, so a reader never sees a partial one. */
async function loadSecret(homePath: string): Promise<Buffer> {
  const file = join(homePath, TASK_SESSION_SECRET_RELATIVE_PATH);
  try {
    return await readSecret(file);
  } catch (error: unknown) {
    if ((error as { code?: unknown }).code !== "ENOENT") throw error;
  }
  await privateDirectory(join(homePath, ".cache"));
  await privateDirectory(join(homePath, ".cache", "matrix"));
  const temporary = `${file}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    const handle = await open(temporary, "wx", 0o600);
    try { await handle.writeFile(`${randomBytes(32).toString("hex")}\n`); }
    finally { await handle.close(); }
    try {
      await link(temporary, file);
    } catch (error: unknown) {
      // Another gateway start created it first; use theirs.
      if ((error as { code?: unknown }).code !== "EEXIST") throw error;
    }
  } finally {
    await unlink(temporary).catch((error: unknown) => {
      if ((error as { code?: unknown }).code !== "ENOENT") console.warn("[project-tasks] task session secret cleanup failed");
    });
  }
  return readSecret(file);
}

export function createTaskSessionCredentials(options: { homePath: string }): TaskSessionCredentials {
  let pending: Promise<Buffer> | undefined;
  const secret = () => {
    pending ??= loadSecret(options.homePath).catch((error: unknown) => { pending = undefined; throw error; });
    return pending;
  };

  return {
    async issue(material) {
      const parsed = MaterialSchema.parse(material);
      const payload = [VERSION, parsed.workspaceId, parsed.tabId, parsed.projectId, parsed.taskId].join(".");
      return `${payload}.${mac(await secret(), payload)}`;
    },
    async verify(token) {
      if (typeof token !== "string" || token.length > MAX_TOKEN_LENGTH) return null;
      const parts = token.split(".");
      if (parts.length !== 6 || parts[0] !== VERSION) return null;
      const [, workspaceId, tabId, projectId, taskId, presented] = parts as [string, string, string, string, string, string];
      const material = MaterialSchema.safeParse({ workspaceId, tabId, projectId, taskId });
      if (!material.success || presented.length !== MAC_LENGTH) return null;
      const expected = Buffer.from(mac(await secret(), parts.slice(0, 5).join(".")));
      const actual = Buffer.from(presented);
      return actual.length === expected.length && timingSafeEqual(actual, expected) ? material.data : null;
    },
  };
}
