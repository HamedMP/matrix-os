import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod/v4";
import {
  resolveKernelCredentialSources,
  type KernelCredentialSources,
} from "../kernel-credentials.js";
import { normalizeKernelModel, type KernelModel } from "../kernel-settings.js";

const SavedKernelConfigSchema = z.object({
  kernel: z.object({
    model: z.unknown().optional(),
  }).passthrough().optional(),
}).passthrough();

export interface AiProviderCredentialSnapshot {
  credentials: KernelCredentialSources;
  savedModel: KernelModel | null;
}

export class ProviderCredentialStore {
  readonly #homePath: string;
  readonly #env: NodeJS.ProcessEnv;

  constructor(options: { homePath: string; env?: NodeJS.ProcessEnv }) {
    if (!options.homePath) throw new Error("AI provider home path is required");
    this.#homePath = options.homePath;
    this.#env = options.env ?? process.env;
  }

  async read(): Promise<AiProviderCredentialSnapshot> {
    const credentials = await resolveKernelCredentialSources(this.#homePath, this.#env);
    let savedModel: KernelModel | null = null;
    try {
      const parsed = SavedKernelConfigSchema.safeParse(JSON.parse(
        await readFile(join(this.#homePath, "system/config.json"), "utf-8"),
      ));
      if (parsed.success) savedModel = normalizeKernelModel(parsed.data.kernel?.model);
    } catch (err) {
      if (!(err instanceof Error) || (err as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn(
          "[ai-providers] Failed to read saved model:",
          err instanceof Error ? err.name : "UnknownError",
        );
      }
    }
    return { credentials, savedModel };
  }
}
