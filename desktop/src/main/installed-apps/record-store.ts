// `<userData>/installed-apps.json`: atomic (temp + rename), serialized
// mutations, capped at 64 records. A corrupt file is logged and never
// silently overwritten: it is moved aside before the next write.
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  InstallIdSchema,
  InstalledAppsFileSchema,
  MAX_INSTALLED_APPS,
  NewInstalledAppSchema,
  type InstalledAppRecord,
  type NewInstalledApp,
} from "./record";

export { MAX_INSTALLED_APPS } from "./record";

const FILE_NAME = "installed-apps.json";
const MAX_FILE_BYTES = 512 * 1024;

export class InstalledAppLimitError extends Error {
  constructor() {
    super("Install limit reached");
    this.name = "InstalledAppLimitError";
  }
}

type ReadResult =
  | { status: "ok"; records: InstalledAppRecord[] }
  | { status: "corrupt"; records: [] };

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "UnknownError";
}

export interface InstalledAppStore {
  list(): Promise<InstalledAppRecord[]>;
  get(installId: string): Promise<InstalledAppRecord | null>;
  create(input: NewInstalledApp): Promise<InstalledAppRecord>;
  remove(installId: string): Promise<boolean>;
}

export function createInstalledAppStore(options: {
  dir: string;
  now?: () => number;
}): InstalledAppStore {
  const filePath = join(options.dir, FILE_NAME);
  const now = options.now ?? Date.now;
  let chain: Promise<unknown> = Promise.resolve();

  async function read(): Promise<ReadResult> {
    let raw: string;
    try {
      raw = await readFile(filePath, "utf8");
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { status: "ok", records: [] };
      // Unreadable is not empty: callers must not mistake it for "no installs".
      console.warn("[installed-apps] install records unreadable:", errorName(error));
      throw new Error("Install records are unavailable");
    }
    try {
      if (Buffer.byteLength(raw) > MAX_FILE_BYTES) throw new RangeError("install records too large");
      const parsed = InstalledAppsFileSchema.safeParse(JSON.parse(raw));
      if (parsed.success) return { status: "ok", records: parsed.data.records };
      console.warn("[installed-apps] install records are invalid; ignoring them:", "ZodError");
    } catch (error: unknown) {
      if (!(error instanceof SyntaxError) && !(error instanceof RangeError)) throw error;
      console.warn("[installed-apps] install records are corrupt; ignoring them:", errorName(error));
    }
    return { status: "corrupt", records: [] };
  }

  async function write(records: InstalledAppRecord[]): Promise<void> {
    await mkdir(options.dir, { recursive: true });
    const tmpPath = `${filePath}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      await writeFile(tmpPath, JSON.stringify({ version: 1, records }, null, 2), { encoding: "utf8", flag: "wx" });
      await rename(tmpPath, filePath);
    } catch (error: unknown) {
      await rm(tmpPath, { force: true }).catch((cleanupError: unknown) => {
        console.warn("[installed-apps] temp file cleanup failed:", errorName(cleanupError));
      });
      throw error;
    }
  }

  /** Mutations run one at a time against a fresh read, so concurrent creates cannot lose a record. */
  function serialize<T>(task: () => Promise<T>): Promise<T> {
    const run = chain.then(task);
    // The caller sees the failure; the queue only waits for it to settle.
    chain = Promise.allSettled([run]);
    return run;
  }

  return {
    async list() {
      return (await read()).records;
    },

    async get(installId) {
      if (!InstallIdSchema.safeParse(installId).success) return null;
      return (await read()).records.find((record) => record.installId === installId) ?? null;
    },

    async create(input) {
      const parsed = NewInstalledAppSchema.parse(input);
      return serialize(async () => {
        const current = await read();
        if (current.status === "corrupt") {
          // Keep one copy of the unreadable file for recovery; never overwrite it unseen.
          await rename(filePath, `${filePath}.corrupt`);
          console.warn("[installed-apps] moved corrupt install records aside");
        }
        if (current.records.length >= MAX_INSTALLED_APPS) throw new InstalledAppLimitError();
        const record: InstalledAppRecord = {
          ...parsed,
          installId: randomUUID(),
          createdAt: new Date(now()).toISOString(),
        };
        await write([...current.records, record]);
        return record;
      });
    },

    remove(installId) {
      if (!InstallIdSchema.safeParse(installId).success) return Promise.resolve(false);
      return serialize(async () => {
        const current = await read();
        const remaining = current.records.filter((record) => record.installId !== installId);
        if (current.status === "corrupt" || remaining.length === current.records.length) return false;
        await write(remaining);
        return true;
      });
    },
  };
}
