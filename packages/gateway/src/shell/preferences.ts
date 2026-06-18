import { link, mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod/v4";
import { writeUtf8FileAtomic } from "./atomic-write.js";
import { shellError } from "./errors.js";
import { validateSessionName } from "./names.js";

const LegacyThemeIdSchema = z.enum([
  "system",
  "one-dark",
  "one-light",
  "catppuccin-mocha",
  "dracula",
  "solarized-dark",
  "solarized-light",
  "nord",
  "github-dark",
  "github-light",
]);

const ShellThemeIdSchema = z.enum(["dark", "light", "matrix"]);

function legacyThemeToShellTheme(themeId: z.infer<typeof LegacyThemeIdSchema> | undefined) {
  switch (themeId) {
    case "one-light":
    case "solarized-light":
    case "github-light":
      return "light";
    case "system":
    case undefined:
      return "dark";
    default:
      return "dark";
  }
}

export const ShellPreferencesSchema = z.preprocess((input) => {
  if (!input || typeof input !== "object") {
    return input;
  }
  const record = input as Record<string, unknown>;
  if (typeof record.shellThemeId === "string") {
    return record;
  }
  const legacy = LegacyThemeIdSchema.safeParse(record.themeId);
  return {
    ...record,
    shellThemeId: legacyThemeToShellTheme(legacy.success ? legacy.data : undefined),
  };
}, z.object({
  shellThemeId: ShellThemeIdSchema.default("dark"),
  fontFamily: z.enum(["MesloLGS NF", "Berkeley Mono", "JetBrains Mono", "Fira Code"]).default("MesloLGS NF"),
  ligatures: z.boolean().default(true),
  cursorStyle: z.enum(["block", "bar", "underline"]).default("block"),
  smoothScroll: z.boolean().default(true),
}));

export type ShellPreferences = z.infer<typeof ShellPreferencesSchema>;
export type ShellThemeId = z.infer<typeof ShellThemeIdSchema>;

export interface ShellPreferencesStoreOptions {
  homePath: string;
  preferencesDir?: string;
}

export class ShellPreferencesStore {
  private readonly preferencesDir: string;

  constructor(options: ShellPreferencesStoreOptions) {
    this.preferencesDir = options.preferencesDir ?? join(options.homePath, "system", "shell-preferences");
  }

  async load(name: string): Promise<ShellPreferences> {
    const safeName = validateSessionName(name);
    try {
      const raw = await readFile(this.pathFor(safeName), "utf-8");
      return ShellPreferencesSchema.parse(JSON.parse(raw));
    } catch (err: unknown) {
      if (
        err instanceof Error &&
        "code" in err &&
        (err as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        return ShellPreferencesSchema.parse({});
      }
      throw err;
    }
  }

  async save(name: string, input: unknown): Promise<ShellPreferences> {
    const safeName = validateSessionName(name);
    const next = ShellPreferencesSchema.parse(input);
    await writeUtf8FileAtomic(this.pathFor(safeName), JSON.stringify(next, null, 2));
    return next;
  }

  async rename(fromName: string, toName: string): Promise<void> {
    const safeFromName = validateSessionName(fromName);
    const safeToName = validateSessionName(toName);
    const fromPath = this.pathFor(safeFromName);
    const toPath = this.pathFor(safeToName);
    await mkdir(dirname(toPath), { recursive: true, mode: 0o700 });
    try {
      await link(fromPath, toPath);
    } catch (err: unknown) {
      if (
        err instanceof Error &&
        "code" in err &&
        (err as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        return;
      }
      if (
        err instanceof Error &&
        "code" in err &&
        (err as NodeJS.ErrnoException).code === "EEXIST"
      ) {
        throw shellError("session_exists", "Session already exists", 409);
      }
      throw err;
    }

    try {
      await rm(fromPath);
    } catch (err: unknown) {
      await rm(toPath, { force: true }).catch((cleanupErr: unknown) => {
        console.warn(
          "[shell] failed to clean copied preferences during rename rollback:",
          cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
        );
      });
      throw err;
    }
  }

  private pathFor(name: string): string {
    return join(this.preferencesDir, `${name}.json`);
  }
}
