import { z } from "zod/v4";

const HermesEnvironmentKeySchema = z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/);
export const HermesConfigPathSchema = z.string()
  .min(1)
  .max(160)
  .regex(/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*){0,7}$/);

export const HermesConfigFieldSchema = z.object({
  type: z.enum(["boolean", "number", "string", "select", "list"]),
  description: z.string().max(512),
  category: z.string().max(64),
  options: z.array(z.string().max(256)).max(128).optional(),
}).strict();

export const HermesConfigurationSchema = z.object({
  config: z.record(z.string(), z.unknown()),
  defaults: z.record(z.string(), z.unknown()),
  fields: z.record(HermesConfigPathSchema, HermesConfigFieldSchema)
    .refine((fields) => Object.keys(fields).length <= 1_024, {
      message: "Hermes configuration exceeds the field limit",
    }),
  categoryOrder: z.array(z.string().max(64)).max(64),
}).strict();

export const HermesConfigValueSchema = z.union([
  z.string().max(8_192),
  z.number().finite(),
  z.boolean(),
  z.array(z.union([
    z.string().max(4_096),
    z.number().finite(),
    z.boolean(),
  ])).max(128),
]);

export const HermesConfigurationChangeSchema = z.object({
  path: HermesConfigPathSchema,
  value: HermesConfigValueSchema,
}).strict();

export const HermesConfigurationChangeRequestSchema = z.object({
  changes: z.array(HermesConfigurationChangeSchema).min(1).max(64),
}).strict();

export const HermesCredentialSetRequestSchema = z.object({
  key: HermesEnvironmentKeySchema,
  value: z.string().max(4_096),
}).strict();

export const HermesCredentialRemoveRequestSchema = z.object({
  key: HermesEnvironmentKeySchema,
}).strict();

// Older host bundles may include an already-sanitized config snapshot in a
// successful response. Consumers use only `ok`; current Gateway routes return
// the normalized shape.
export const HermesMutationResponseSchema = z.object({ ok: z.literal(true) }).passthrough();

export const HermesEnvironmentEntrySchema = z.object({
  is_set: z.boolean(),
  redacted_value: z.string().max(512).nullable().optional(),
  description: z.string().max(512).default(""),
  url: z.string().url().max(2_048).nullable().optional(),
  category: z.string().max(64).default(""),
  is_password: z.boolean().default(true),
  tools: z.array(z.string().max(128)).max(128).default([]),
  advanced: z.boolean().default(false),
  channel_managed: z.boolean().default(false),
  provider: z.string().max(128).default(""),
  provider_label: z.string().max(128).default(""),
}).strict();

export const HermesEnvironmentSchema = z
  .record(HermesEnvironmentKeySchema, HermesEnvironmentEntrySchema)
  .refine((environment) => Object.keys(environment).length <= 1_024, {
    message: "Hermes environment metadata exceeds the entry limit",
  });

export type HermesEnvironmentEntry = z.infer<typeof HermesEnvironmentEntrySchema>;
export type HermesEnvironment = z.infer<typeof HermesEnvironmentSchema>;
export type HermesConfigField = z.infer<typeof HermesConfigFieldSchema>;
export type HermesConfiguration = z.infer<typeof HermesConfigurationSchema>;
export type HermesConfigValue = z.infer<typeof HermesConfigValueSchema>;
export type HermesConfigurationChange = z.infer<typeof HermesConfigurationChangeSchema>;
export type HermesConfigChange = HermesConfigurationChange;
export type HermesConfigurationChangeRequest = z.infer<typeof HermesConfigurationChangeRequestSchema>;
export type HermesCredentialSetRequest = z.infer<typeof HermesCredentialSetRequestSchema>;
export type HermesCredentialRemoveRequest = z.infer<typeof HermesCredentialRemoveRequestSchema>;
export type HermesMutationResponse = z.infer<typeof HermesMutationResponseSchema>;
