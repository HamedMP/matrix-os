import {
  CodingAgentNotificationPreferencesSchema,
  type CodingAgentAttentionNotificationKind,
  type CodingAgentNotificationPreferences,
  type CodingAgentNotificationPreferencesUpdate,
} from "@matrix-os/contracts";
import type { RequestPrincipal } from "../request-principal.js";
import {
  createNotificationPreferenceStore, legacyNotificationKindEnabled, projectLegacyNotificationPreferences,
  type NotificationPreferenceStore, type NotificationPreferenceStoreOptions,
} from "../notifications/preferences-store.js";

export const DEFAULT_CODING_AGENT_NOTIFICATION_PREFERENCES: CodingAgentNotificationPreferences =
  CodingAgentNotificationPreferencesSchema.parse({ attentionPush: { approval: true, input: true, failed: true, completed: true } });

export interface CodingAgentNotificationPreferenceStore {
  readonly preferences: NotificationPreferenceStore;
  load(principal: RequestPrincipal): Promise<CodingAgentNotificationPreferences>;
  save(principal: RequestPrincipal, preferences: CodingAgentNotificationPreferencesUpdate): Promise<CodingAgentNotificationPreferences>;
  isAttentionPushEnabled(input: { ownerId: string; threadId?: string; kind: CodingAgentAttentionNotificationKind }): Promise<boolean>;
}
export interface CodingAgentNotificationPreferenceStoreOptions extends NotificationPreferenceStoreOptions {
  preferences?: NotificationPreferenceStore;
}

/** Compatibility projection only: every consumer shares the owner document and its mutex. */
export function createCodingAgentNotificationPreferenceStore(options: CodingAgentNotificationPreferenceStoreOptions): CodingAgentNotificationPreferenceStore {
  const preferences = options.preferences ?? createNotificationPreferenceStore(options);
  return {
    preferences,
    async load(principal) { return projectLegacyNotificationPreferences(await preferences.load(principal)); },
    async save(principal, document) { return projectLegacyNotificationPreferences(await preferences.updateLegacy(principal, document)); },
    async isAttentionPushEnabled({ ownerId, kind }) {
      return legacyNotificationKindEnabled(await preferences.load({ userId: ownerId, source: "jwt" }), kind);
    },
  };
}
