import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod/v4";
import { getConfigDir } from "../../lib/config.js";
import { writeUtf8FileAtomic } from "../../lib/atomic-write.js";

export const TuiPreferencesSchema = z.object({
  theme: z.enum(["system", "dark", "light"]).default("system"),
  noColor: z.boolean().default(false),
  defaultView: z.enum(["home", "sessions", "projects"]).default("home"),
  shortcutHelpVisible: z.boolean().default(true),
  mascotVisible: z.boolean().default(true),
  nativeWritebackChoices: z.record(z.string(), z.boolean()).default({}),
});

export type TuiPreferences = z.infer<typeof TuiPreferencesSchema>;

export interface TuiPreferenceOptions {
  configDir?: string;
}

export interface TuiPreferenceLoadResult {
  preferences: TuiPreferences;
  recovered: boolean;
}

const DEFAULT_PREFERENCES = TuiPreferencesSchema.parse({});

function preferencePath(options: TuiPreferenceOptions = {}): string {
  return join(options.configDir ?? getConfigDir(), "tui.json");
}

export async function loadTuiPreferences(
  options: TuiPreferenceOptions = {},
): Promise<TuiPreferenceLoadResult> {
  const filePath = preferencePath(options);
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    const preferences = TuiPreferencesSchema.parse(parsed);
    return { preferences, recovered: false };
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return { preferences: DEFAULT_PREFERENCES, recovered: false };
    }
    return { preferences: DEFAULT_PREFERENCES, recovered: true };
  }
}

export async function saveTuiPreferences(
  preferences: Partial<TuiPreferences>,
  options: TuiPreferenceOptions = {},
): Promise<void> {
  const filePath = preferencePath(options);
  const normalized = TuiPreferencesSchema.parse({
    ...DEFAULT_PREFERENCES,
    ...preferences,
  });
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
  await writeUtf8FileAtomic(filePath, `${JSON.stringify(normalized, null, 2)}\n`, 0o600);
}
