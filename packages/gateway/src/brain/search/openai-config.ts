/**
 * The owner's Company Brain embeddings settings and OpenAI key. Settings live at brain.embeddings in
 * <home>/system/config.json ({ openai_key, model, dimensions, provenances }), apart from tools.embeddings, so a key
 * set up for another feature never turns meaning search on. The file is read bounded (a symlink, non-file, oversize
 * file or bad JSON reads as absent; other file system errors reject). Embeddings are on only by the owner's choice:
 * openai_key holds their key, or "${OPENAI_API_KEY}" to use the gateway's own OPENAI_API_KEY (taken only when
 * OPENAI_BASE_URL is unset or blank, so a relay key never goes to api.openai.com). An empty or absent openai_key is
 * off, whatever the environment holds. provenances names which documents may be sent (default: git_pr, git_commit and
 * git_spec only); chats, notes, files, calendar events and connector text are sent only when listed. The key is read
 * again for every call and never cached, logged, stored or returned beyond it; the provenances are read again at the
 * start of every refresh and search (currentProvenances), so a narrowed list applies without a restart, and settings
 * that turned invalid or lost their key send nothing.
 */
import { join } from "node:path";
import { z } from "zod/v4";
import { readBoundedJsonFileWithIdentity } from "../../bounded-json-file.js";
import { BRAIN_PROVENANCES } from "../contracts.js";
import { BRAIN_OPENAI_EMBEDDINGS_LIMITS, BRAIN_OPENAI_EMBEDDINGS_MODEL, createBrainOpenAiEmbeddings } from "./openai.js";
import {
  BRAIN_SEARCH_EMBED_DEFAULT_PROVENANCES, BRAIN_SEARCH_EMBED_PROVENANCES_MAX, type BrainMeteredEmbeddingsProvider,
  type BrainSearchEmbeddingsAllowance,
} from "./types.js";

const OWNER_CONFIG_PATH = "system/config.json";
const OWNER_CONFIG_MAX_BYTES = 64 * 1024;
const DEFAULT_DIMENSIONS = 256;
/** An OpenAI secret key: "sk-" then key characters, at most 512 in all; a "${...}" placeholder never matches. */
const KEY_PATTERN = /^sk-[A-Za-z0-9_-]{16,509}$/;
/** The owner's opt-in to the environment key, in the "${VAR}" form the tools.web keys use. */
const ENVIRONMENT_KEY = "${OPENAI_API_KEY}";

const BlockSchema = z.object({ brain: z.object({ embeddings: z.object({
  openai_key: z.unknown(), model: z.unknown(), dimensions: z.unknown(), provenances: z.unknown(),
}).partial() }) });
const DimensionsSchema = z.number().int().min(1).max(BRAIN_OPENAI_EMBEDDINGS_LIMITS.dimensionsMax);
/** Known provenances only, each once, at least one. */
const ProvenancesSchema = z.array(z.enum(Object.values(BRAIN_PROVENANCES) as [string, ...string[]]))
  .min(1).max(BRAIN_SEARCH_EMBED_PROVENANCES_MAX).refine((values) => new Set(values).size === values.length);

export type BrainEmbeddingsEnv = Readonly<Record<string, string | undefined>>;
type Settings =
  | {
    readonly ok: true; readonly dimensions: number; readonly key: string | null;
    readonly provenances: readonly string[];
  }
  | { readonly ok: false; readonly field: "openai_key" | "model" | "dimensions" | "provenances" };

/** Absent fields take the defaults; a present field of the wrong value turns embeddings off. */
async function readSettings(homePath: string): Promise<Settings> {
  const document = await readBoundedJsonFileWithIdentity(join(homePath, OWNER_CONFIG_PATH), OWNER_CONFIG_MAX_BYTES);
  const block = BlockSchema.safeParse(document?.value);
  const { openai_key: key = "", model, dimensions, provenances } = block.success ? block.data.brain.embeddings : {};
  if (model !== undefined && model !== BRAIN_OPENAI_EMBEDDINGS_MODEL) return { ok: false, field: "model" };
  const size = dimensions === undefined ? DEFAULT_DIMENSIONS : DimensionsSchema.safeParse(dimensions).data;
  if (size === undefined) return { ok: false, field: "dimensions" };
  const allowed = provenances === undefined ? BRAIN_SEARCH_EMBED_DEFAULT_PROVENANCES
    : ProvenancesSchema.safeParse(provenances).data;
  if (allowed === undefined) return { ok: false, field: "provenances" };
  const owner = typeof key === "string" ? key.trim() : key === null ? "" : null;
  const valid = owner === "" || owner === ENVIRONMENT_KEY || (owner !== null && KEY_PATTERN.test(owner));
  if (!valid) return { ok: false, field: "openai_key" };
  return { ok: true, dimensions: size, key: owner === "" ? null : owner, provenances: allowed };
}

function resolveKey(settings: Settings, env: BrainEmbeddingsEnv): { apiKey: string; source: string } | null {
  if (!settings.ok || settings.key === null) return null;
  if (settings.key !== ENVIRONMENT_KEY) return { apiKey: settings.key, source: "owner_key" };
  const apiKey = env.OPENAI_API_KEY?.trim();
  const baseUrl = env.OPENAI_BASE_URL?.trim();
  if (apiKey === undefined || !KEY_PATTERN.test(apiKey) || (baseUrl !== undefined && baseUrl !== "")) return null;
  return { apiKey, source: "environment" };
}

/**
 * The provider when the settings are valid and a key exists at start; else null (full text only). An invalid setting
 * is logged by field name. Each call reads the key again: a key removed later makes calls not_configured. Each
 * refresh and search reads the provenances again (an invalid file or setting reads as none).
 */
export async function createBrainSearchEmbeddings(options: {
  readonly homePath: string; readonly env: BrainEmbeddingsEnv; readonly fetch?: typeof globalThis.fetch;
}): Promise<(BrainMeteredEmbeddingsProvider & BrainSearchEmbeddingsAllowance) | null> {
  const settings = await readSettings(options.homePath);
  if (!settings.ok) {
    console.warn("[brain-search] embeddings disabled by an invalid setting", { field: settings.field });
    return null;
  }
  const credential = resolveKey(settings, options.env);
  if (credential === null) return null;
  console.info("[brain-search] OpenAI embeddings on", {
    source: credential.source, dimensions: settings.dimensions, provenances: settings.provenances,
  });
  const provider = createBrainOpenAiEmbeddings({
    dimensions: settings.dimensions,
    apiKey: async () => resolveKey(await readSettings(options.homePath), options.env)?.apiKey ?? null,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
  return {
    ...provider, provenances: settings.provenances,
    async currentProvenances() {
      const current = await readSettings(options.homePath);
      // Off now (an invalid setting, or no key any more): nothing may be sent.
      return current.ok && resolveKey(current, options.env) !== null ? current.provenances : [];
    },
  };
}
