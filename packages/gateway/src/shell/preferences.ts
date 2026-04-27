import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod/v4";
import { writeUtf8FileAtomic } from "./atomic-write.js";
import { validateSessionName } from "./names.js";

export const ShellPreferencesSchema = z.object({
  themeId: z.enum([
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
  ]).default("system"),
  fontFamily: z.enum(["Berkeley Mono", "JetBrains Mono", "Fira Code"]).default("JetBrains Mono"),
  ligatures: z.boolean().default(true),
  cursorStyle: z.enum(["block", "bar", "underline"]).default("block"),
  smoothScroll: z.boolean().default(true),
});

export type ShellPreferences = z.infer<typeof ShellPreferencesSchema>;

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

  private pathFor(name: string): string {
    return join(this.preferencesDir, `${name}.json`);
  }
}
