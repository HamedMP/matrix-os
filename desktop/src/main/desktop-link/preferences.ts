// Which computers the person let use this device (spec 2716), per Electron
// profile, in userData. Holds no secrets: the device key lives in the
// desktop-pairing key store and bearers live in memory only.
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod/v4";
import { DesktopLinkRevisionSchema } from "@matrix-os/contracts/desktop-link";

const MAX_COMPUTERS = 20;
const MAX_FILE_BYTES = 64 * 1024;

const ComputerSchema = z.strictObject({
  enabled: z.boolean(),
  computerName: z.string().min(1).max(64),
  machineId: z.uuid(),
  revision: DesktopLinkRevisionSchema,
});
const PreferencesSchema = z.strictObject({
  computers: z.record(z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/), ComputerSchema)
    .refine((computers) => Object.keys(computers).length <= MAX_COMPUTERS),
});
export type DesktopLinkPreferences = z.infer<typeof PreferencesSchema>;

export interface DesktopLinkPreferenceStore {
  load(): Promise<DesktopLinkPreferences>;
  save(preferences: DesktopLinkPreferences): Promise<void>;
}

const EMPTY: DesktopLinkPreferences = { computers: {} };

export function createDesktopLinkPreferenceStore(userData: string, log: (message: string) => void = (message) => console.warn(`[desktop-link] ${message}`)): DesktopLinkPreferenceStore {
  const path = join(userData, "desktop-link.json");
  // Writes run one after another, so an older choice never lands after a newer one.
  let writing: Promise<void> = Promise.resolve();
  return {
    async load() {
      let text: string;
      try {
        text = await readFile(path, "utf8");
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return EMPTY;
        throw error;
      }
      if (text.length > MAX_FILE_BYTES) { log("preferences too large; ignoring"); return EMPTY; }
      try {
        const parsed = PreferencesSchema.safeParse(JSON.parse(text));
        if (parsed.success) return parsed.data;
        log("preferences unreadable; ignoring");
        return EMPTY;
      } catch (error: unknown) {
        if (!(error instanceof SyntaxError)) throw error;
        log("preferences unreadable; ignoring");
        return EMPTY;
      }
    },
    save(preferences) {
      const valid = PreferencesSchema.parse(preferences);
      const next = writing.then(async () => {
        await mkdir(userData, { recursive: true });
        const temporary = `${path}.${randomBytes(6).toString("hex")}.tmp`;
        try {
          await writeFile(temporary, JSON.stringify(valid), { mode: 0o600, flag: "wx" });
          await rename(temporary, path);
        } finally {
          await rm(temporary, { force: true });
        }
      });
      writing = next.catch((error: unknown) => {
        log(`preferences not saved: ${error instanceof Error ? error.name : "UnknownError"}`);
      });
      return next;
    },
  };
}
