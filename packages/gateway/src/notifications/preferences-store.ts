import { createHash } from "node:crypto";
import { mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import {
  CodingAgentNotificationPreferencesSchema,
  CodingAgentNotificationPreferencesUpdateSchema,
  DEFAULT_NOTIFICATION_PREFERENCES,
  NotificationPreferencesSchema,
  type CodingAgentNotificationPreferences,
  type CodingAgentNotificationPreferencesUpdate,
  type NotificationPreferences,
} from "@matrix-os/contracts";
import { withPinnedSystemDir, type PinnedSystemDir } from "../get-started/owner-system-dir.js";
import { logCodingAgentWarning } from "../coding-agents/diagnostics.js";
import { withOwnerFileMutation } from "../owner-file-mutations.js";
import { SAFE_PRINCIPAL_USER_ID, type RequestPrincipal } from "../request-principal.js";

const FILE_NAME = "notifications.json";
const MAX_BYTES = 16 * 1024;
const KIND_MAP = { approval: "approval", input: "question", completed: "replyFinished", failed: "runFailed" } as const;

export class NotificationPreferencesAccessError extends Error {
  constructor() { super("Notification preferences require the runtime owner"); }
}
export class NotificationPreferencesConflictError extends Error {
  readonly code = "notification_preferences_conflict";
  constructor() { super("Notification preferences changed. Reload and try again."); }
}
export class NotificationPreferencesUnavailableError extends Error {
  constructor(options?: ErrorOptions) { super("Notification preferences unavailable", options); }
}

export interface NotificationPreferenceStore {
  assertOwner(principal: RequestPrincipal): void;
  load(principal: RequestPrincipal): Promise<NotificationPreferences>;
  save(principal: RequestPrincipal, document: NotificationPreferences): Promise<NotificationPreferences>;
  updateLegacy(principal: RequestPrincipal, patch: CodingAgentNotificationPreferencesUpdate, expectedRevision?: number): Promise<NotificationPreferences>;
}
export interface NotificationPreferenceStoreOptions {
  homePath: string;
  /** Ordered runtime owner identities; canonical id first, Clerk alias second. Never client input. */
  ownerIds?: readonly string[];
}

function ownerFileName(ownerId: string): string {
  return /^[A-Za-z0-9_-]{1,128}$/.test(ownerId) ? `${ownerId}.json`
    : `owner_${createHash("sha256").update(ownerId).digest("hex")}.json`;
}

async function legacyPreferences(dir: PinnedSystemDir, ownerIds: readonly string[]) {
  // Do not follow legacy parent symlinks, or treat an unsafe/corrupt file as missing.
  for (const parent of ["coding-agents", "coding-agents/notification-preferences"]) {
    const entry = await dir.lstat(parent);
    if (!entry) return null;
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new NotificationPreferencesUnavailableError();
  }
  for (const ownerId of ownerIds) {
    const raw = await dir.readFile(`coding-agents/notification-preferences/${ownerFileName(ownerId)}`, MAX_BYTES);
    if (raw !== null) return CodingAgentNotificationPreferencesSchema.parse(JSON.parse(raw));
  }
  return null;
}

function withLegacyEvents(document: NotificationPreferences, legacy: CodingAgentNotificationPreferencesUpdate): NotificationPreferences {
  const events = { ...document.events };
  for (const kind of Object.keys(KIND_MAP) as Array<keyof typeof KIND_MAP>) {
    const enabled = legacy.attentionPush[kind];
    if (enabled !== undefined) events[KIND_MAP[kind]] = enabled;
  }
  return { ...document, events };
}

export function projectLegacyNotificationPreferences(document: NotificationPreferences): CodingAgentNotificationPreferences {
  return { attentionPush: {
    approval: document.events.approval, input: document.events.question,
    failed: document.events.runFailed, completed: document.events.replyFinished,
  } };
}
export function legacyNotificationKindEnabled(document: NotificationPreferences, kind: keyof typeof KIND_MAP): boolean {
  return document.events[KIND_MAP[kind]];
}

export function createNotificationPreferenceStore(options: NotificationPreferenceStoreOptions): NotificationPreferenceStore {
  const ownerIds = [...new Set(options.ownerIds ?? [])];
  if (ownerIds.length > 8 || ownerIds.some(id => !SAFE_PRINCIPAL_USER_ID.test(id))) {
    throw new NotificationPreferencesUnavailableError();
  }
  function assertOwner(principal: RequestPrincipal): void {
    if (!SAFE_PRINCIPAL_USER_ID.test(principal.userId) || (ownerIds.length > 0
      ? !ownerIds.includes(principal.userId)
      : principal.source !== "dev-default" && principal.source !== "configured-container")) {
      throw new NotificationPreferencesAccessError();
    }
  }
  async function locked<T>(principal: RequestPrincipal, operation: (dir: PinnedSystemDir, current: NotificationPreferences) => Promise<T>): Promise<T> {
    assertOwner(principal);
    try {
      const homePath = await realpath(options.homePath);
      // This bounded shared process mutex covers migration, read, revision check and atomic rename,
      // including independently created legacy adapters. No module-local per-instance lock can race it.
      return await withOwnerFileMutation(homePath, async () => {
        try { await mkdir(join(homePath, "system"), { mode: 0o700 }); }
        catch (error: unknown) {
          if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
        }
        const result = await withPinnedSystemDir(homePath, async dir => {
          const raw = await dir.readFile(FILE_NAME, MAX_BYTES);
          let current: NotificationPreferences;
          if (raw !== null) current = NotificationPreferencesSchema.parse(JSON.parse(raw));
          else {
            current = NotificationPreferencesSchema.parse(DEFAULT_NOTIFICATION_PREFERENCES);
            const legacy = await legacyPreferences(dir, ownerIds.length ? ownerIds : [principal.userId]);
            if (legacy) current = withLegacyEvents(current, legacy);
            await dir.writeAtomic(FILE_NAME, `${JSON.stringify(current, null, 2)}\n`, 0o600);
          }
          return operation(dir, current);
        });
        if (result === null) throw new NotificationPreferencesUnavailableError();
        return result;
      });
    } catch (error: unknown) {
      if (error instanceof NotificationPreferencesConflictError) throw error;
      logCodingAgentWarning("notification preferences storage failed", error);
      throw new NotificationPreferencesUnavailableError({ cause: error });
    }
  }
  async function commit(dir: PinnedSystemDir, document: NotificationPreferences, current: NotificationPreferences) {
    if (current.revision === Number.MAX_SAFE_INTEGER) throw new NotificationPreferencesUnavailableError();
    const next = { ...document, revision: current.revision + 1 };
    await dir.writeAtomic(FILE_NAME, `${JSON.stringify(next, null, 2)}\n`, 0o600);
    return next;
  }
  return {
    assertOwner,
    load: principal => locked(principal, async (_dir, current) => current),
    save(principal, document) {
      assertOwner(principal);
      const parsed = NotificationPreferencesSchema.parse(document);
      return locked(principal, async (dir, current) => {
        if (parsed.revision !== current.revision) throw new NotificationPreferencesConflictError();
        return commit(dir, parsed, current);
      });
    },
    updateLegacy(principal, document, expectedRevision) {
      assertOwner(principal);
      const parsed = CodingAgentNotificationPreferencesUpdateSchema.parse(document);
      return locked(principal, (dir, current) => {
        if (expectedRevision !== undefined && expectedRevision !== current.revision) throw new NotificationPreferencesConflictError();
        return commit(dir, withLegacyEvents(current, parsed), current);
      });
    },
  };
}
