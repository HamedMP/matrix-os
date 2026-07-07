import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  CodingAgentNotificationPreferencesSchema,
  CodingAgentNotificationPreferencesUpdateSchema,
  type CodingAgentAttentionNotificationKind,
  type CodingAgentNotificationPreferences,
  type CodingAgentNotificationPreferencesUpdate,
} from "@matrix-os/contracts";
import type { RequestPrincipal } from "../request-principal.js";
import { atomicWriteJson, readJsonFile } from "../state-ops.js";

const NOTIFICATION_PREFERENCES_RELATIVE_PATH = ["system", "coding-agents", "notification-preferences"] as const;
const SAFE_OWNER_FILE_NAME = /^[A-Za-z0-9_-]{1,128}$/;

export const DEFAULT_CODING_AGENT_NOTIFICATION_PREFERENCES: CodingAgentNotificationPreferences =
  CodingAgentNotificationPreferencesSchema.parse({
    attentionPush: {
      approval: true,
      input: true,
      failed: true,
    },
  });

export interface CodingAgentNotificationPreferenceStore {
  load(principal: RequestPrincipal): Promise<CodingAgentNotificationPreferences>;
  save(
    principal: RequestPrincipal,
    preferences: CodingAgentNotificationPreferencesUpdate,
  ): Promise<CodingAgentNotificationPreferences>;
  isAttentionPushEnabled(input: {
    ownerId: string;
    threadId?: string;
    kind: CodingAgentAttentionNotificationKind;
  }): Promise<boolean>;
}

export interface CodingAgentNotificationPreferenceStoreOptions {
  homePath: string;
}

function ownerFileName(ownerId: string): string {
  if (SAFE_OWNER_FILE_NAME.test(ownerId)) return `${ownerId}.json`;
  return `owner_${createHash("sha256").update(ownerId).digest("hex")}.json`;
}

function preferencesPath(homePath: string, ownerId: string): string {
  return join(homePath, ...NOTIFICATION_PREFERENCES_RELATIVE_PATH, ownerFileName(ownerId));
}

function isNotFound(err: unknown): boolean {
  return err instanceof Error
    && "code" in err
    && (err as NodeJS.ErrnoException).code === "ENOENT";
}

export function createCodingAgentNotificationPreferenceStore(
  options: CodingAgentNotificationPreferenceStoreOptions,
): CodingAgentNotificationPreferenceStore {
  async function load(principal: RequestPrincipal): Promise<CodingAgentNotificationPreferences> {
    const path = preferencesPath(options.homePath, principal.userId);
    try {
      return CodingAgentNotificationPreferencesSchema.parse(await readJsonFile(path));
    } catch (err: unknown) {
      if (isNotFound(err)) return DEFAULT_CODING_AGENT_NOTIFICATION_PREFERENCES;
      throw err;
    }
  }

  return {
    load,
    async save(principal, preferences) {
      const path = preferencesPath(options.homePath, principal.userId);
      const parsed = CodingAgentNotificationPreferencesUpdateSchema.parse(preferences);
      await atomicWriteJson(path, parsed);
      return parsed;
    },
    async isAttentionPushEnabled({ ownerId, kind }) {
      const preferences = await load({ userId: ownerId, source: "jwt" });
      return preferences.attentionPush[kind];
    },
  };
}
