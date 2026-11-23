/**
 * Voice profiles cached per account and recipient: in memory (capped, least
 * recently used evicted) and in the app table `mail_voice_profiles`.
 *
 * The table must be declared in the Mail app's matrix.json:
 *   "mail_voice_profiles": { "columns": { "profile_key": "text", "account_id": "text",
 *     "profile": "jsonb", "derived_at": "number" }, "indexes": ["account_id"],
 *     "uniqueIndexes": ["profile_key"] }
 *
 * A database failure never breaks drafting: it is logged and the memory copy is used.
 */
import { normalizeMailAddress } from "../../../_shared/office-accounts/types/mail";
import type { MatrixOSDbFilter, MatrixOSDbRow } from "../../../_shared/matrix-os";
import { defaultAgentLogger, type AgentLogger } from "./errors";
import { MAX_VOICE_PROFILES_IN_MEMORY, VOICE_PROFILE_TTL_MS } from "./limits";
import type { VoiceProfile } from "./voice-derive";

export const VOICE_TABLE = "mail_voice_profiles";

/** The part of `MatrixOS.db` this cache uses. */
export interface VoiceCacheDb {
  find(table: string, options?: { where?: MatrixOSDbFilter; limit?: number }): Promise<MatrixOSDbRow[]>;
  insert(table: string, data: MatrixOSDbRow): Promise<{ id: string }>;
  update(table: string, id: string, data: MatrixOSDbRow): Promise<{ ok: true }>;
}

export interface VoiceProfileCache {
  /** A fresh profile, or null when none is cached or it expired. `recipient` null is the overall voice. */
  get(accountId: string, recipient: string | null): Promise<VoiceProfile | null>;
  set(accountId: string, recipient: string | null, profile: VoiceProfile): Promise<void>;
}

export interface VoiceCacheOptions {
  now?: () => number;
  ttlMs?: number;
  logger?: AgentLogger;
}

export function voiceProfileKey(accountId: string, recipient: string | null): string {
  return `${accountId}\u001f${recipient ? normalizeMailAddress(recipient) : "*"}`;
}

const FORMALITY = new Set(["formal", "neutral", "casual"]);
const LENGTH = new Set(["short", "medium", "long"]);
const nullableText = (value: unknown, max: number) => value === null || (typeof value === "string" && value.length <= max);

/** Checks a stored profile; rows written by an older or broken version read as missing. */
export function isVoiceProfile(value: unknown): value is VoiceProfile {
  if (typeof value !== "object" || value === null) return false;
  const p = value as Record<string, unknown>;
  return p.version === 1
    && nullableText(p.recipient, 254)
    && typeof p.sampleCount === "number" && Number.isFinite(p.sampleCount)
    && nullableText(p.greeting, 80) && nullableText(p.signOff, 80) && nullableText(p.signatureName, 80)
    && typeof p.formality === "string" && FORMALITY.has(p.formality)
    && typeof p.typicalWords === "number" && Number.isFinite(p.typicalWords)
    && typeof p.length === "string" && LENGTH.has(p.length)
    && typeof p.language === "string" && p.language.length <= 8
    && Array.isArray(p.excerpts) && p.excerpts.length <= 4 && p.excerpts.every((e) => typeof e === "string" && e.length <= 400)
    && typeof p.derivedAt === "number" && Number.isFinite(p.derivedAt);
}

export function createVoiceProfileCache(db: VoiceCacheDb | undefined, options: VoiceCacheOptions = {}): VoiceProfileCache {
  const now = options.now ?? (() => Date.now());
  const ttl = options.ttlMs ?? VOICE_PROFILE_TTL_MS;
  const log = options.logger ?? defaultAgentLogger;
  const memory = new Map<string, VoiceProfile>();

  const fresh = (profile: VoiceProfile) => now() - profile.derivedAt < ttl && profile.derivedAt <= now() + 60_000;

  function remember(key: string, profile: VoiceProfile): void {
    memory.delete(key);
    memory.set(key, profile);
    while (memory.size > MAX_VOICE_PROFILES_IN_MEMORY) {
      const oldest = memory.keys().next().value;
      if (oldest === undefined) break;
      memory.delete(oldest);
    }
  }

  async function findRow(key: string): Promise<MatrixOSDbRow | null> {
    if (!db) return null;
    const rows = await db.find(VOICE_TABLE, { where: { profile_key: key }, limit: 1 });
    return rows[0] ?? null;
  }

  return {
    async get(accountId, recipient) {
      const key = voiceProfileKey(accountId, recipient);
      const cached = memory.get(key);
      if (cached) {
        if (fresh(cached)) {
          remember(key, cached);
          return cached;
        }
        memory.delete(key);
      }
      try {
        const row = await findRow(key);
        const profile = row?.profile;
        if (!isVoiceProfile(profile) || !fresh(profile)) return null;
        remember(key, profile);
        return profile;
      } catch (error: unknown) {
        log("voice.cache.read.failed", error);
        return null;
      }
    },

    async set(accountId, recipient, profile) {
      const key = voiceProfileKey(accountId, recipient);
      remember(key, profile);
      if (!db) return;
      const data = { profile_key: key, account_id: accountId, profile: profile as unknown as MatrixOSDbRow, derived_at: profile.derivedAt };
      try {
        const existing = await findRow(key);
        if (existing && typeof existing.id === "string") {
          await db.update(VOICE_TABLE, existing.id, data);
          return;
        }
        try {
          await db.insert(VOICE_TABLE, data);
        } catch (error: unknown) {
          // Another window inserted the same key first: update that row instead.
          const raced = await findRow(key);
          if (!raced || typeof raced.id !== "string") throw error;
          await db.update(VOICE_TABLE, raced.id, data);
        }
      } catch (error: unknown) {
        log("voice.cache.write.failed", error);
      }
    },
  };
}
