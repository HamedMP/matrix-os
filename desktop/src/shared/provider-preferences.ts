import {
  CanonicalChatModelReferenceSchema,
  CanonicalProviderInstanceIdSchema,
} from "@matrix-os/contracts";
import { z } from "zod/v4";

const PreferenceIdSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,79}$/);

export const ComposerOptionPreferenceSchema = z.strictObject({
  id: PreferenceIdSchema,
  value: z.union([z.string().max(128), z.boolean()]),
});

export const ComposerSelectionPreferenceSchema = z.strictObject({
  model: CanonicalChatModelReferenceSchema.optional(),
  options: z.array(ComposerOptionPreferenceSchema).max(16),
  permissionMode: PreferenceIdSchema,
});

export const ComposerSelectionsSchema = z
  .record(CanonicalProviderInstanceIdSchema, ComposerSelectionPreferenceSchema)
  .refine((selections) => Object.keys(selections).length <= 20, {
    message: "too many composer selection preferences",
  });

export const ProviderPreferencesSchema = z.strictObject({
  defaultProviderId: PreferenceIdSchema.nullable(),
  lastComposerInstanceId: CanonicalProviderInstanceIdSchema.optional(),
  composerSelections: ComposerSelectionsSchema.optional(),
});

export type ComposerSelectionPreference = z.infer<typeof ComposerSelectionPreferenceSchema>;
export type ComposerSelectionPreferences = z.infer<typeof ComposerSelectionsSchema>;
export type ProviderPreferences = z.infer<typeof ProviderPreferencesSchema>;
