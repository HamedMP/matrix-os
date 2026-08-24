import { z } from "zod/v4";
import {
  CanonicalChatAttachmentKindSchema,
  CanonicalChatModelSelectionSchema,
  CanonicalProviderInstanceIdSchema,
} from "#canonical-chat";

const SAFE_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/;
const SAFE_DISPLAY_TEXT =
  /(postgres(?:ql)?:\/\/|\/home\/|\/tmp\/|\/var\/|\/opt\/|\/etc\/|\/root\/|\/Users\/|[A-Za-z]:[\\/]|\.ssh\/|bearer\s+|sk-[A-Za-z0-9_-]+|password\s*[=:]|token\s*[=:])/i;

function safeReference(max = 160) {
  return z.string().min(1).max(max).regex(SAFE_REFERENCE)
    .refine((value) => !value.includes(".."), { message: "Invalid reference" });
}

function safeLabel(max = 160) {
  return z.string().trim().min(1).max(max)
    .refine((value) => !SAFE_DISPLAY_TEXT.test(value), {
      message: "Text is not safe for display",
    });
}

function unique(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

export const CanonicalProviderDriverKindSchema = z.enum([
  "hermes",
  "openclaw",
  "codex",
  "claude_code",
  "opencode",
  "pi",
]);

export const CanonicalProviderDriverDescriptorSchema = z.object({
  kind: CanonicalProviderDriverKindSchema,
  displayName: safeLabel(80),
  adapterVersion: z.string().min(1).max(64).regex(/^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?$/),
  capabilityClass: z.enum(["system_agent", "coding_agent"]),
}).strict();

export const CanonicalModelCapabilitySchema = z.enum([
  "reasoning",
  "tools",
  "vision",
  "audio",
  "long_context",
]);

export const CanonicalModelDescriptorSchema = z.object({
  id: safeReference(160),
  displayName: safeLabel(120),
  description: safeLabel(280).optional(),
  availability: z.enum(["available", "auth_required", "unavailable"]),
  capabilities: z.array(CanonicalModelCapabilitySchema).max(16),
  contextWindow: z.number().int().min(1).max(10_000_000).optional(),
  supportsVision: z.boolean(),
  supportsToolUse: z.boolean(),
}).strict().superRefine((model, ctx) => {
  if (!unique(model.capabilities)) {
    ctx.addIssue({ code: "custom", path: ["capabilities"], message: "Duplicate capability" });
  }
});

const CanonicalProviderOptionValueSchema = z.object({
  value: safeReference(160),
  label: safeLabel(120),
}).strict();

export const CanonicalProviderOptionDescriptorSchema = z.object({
  id: safeReference(80),
  label: safeLabel(120),
  kind: z.enum(["enum", "boolean"]),
  values: z.array(CanonicalProviderOptionValueSchema).min(1).max(32).optional(),
  defaultValue: z.union([safeReference(160), z.boolean()]).optional(),
  placement: z.enum(["composer", "advanced"]),
}).strict().superRefine((option, ctx) => {
  if (option.kind === "enum") {
    if (option.values === undefined || option.values.length === 0) {
      ctx.addIssue({ code: "custom", path: ["values"], message: "Enum options require values" });
      return;
    }
    const values = option.values.map((value) => value.value);
    if (!unique(values)) {
      ctx.addIssue({ code: "custom", path: ["values"], message: "Duplicate option value" });
    }
    if (typeof option.defaultValue === "boolean") {
      ctx.addIssue({ code: "custom", path: ["defaultValue"], message: "Enum default must be a value" });
    } else if (option.defaultValue !== undefined && !values.includes(option.defaultValue)) {
      ctx.addIssue({ code: "custom", path: ["defaultValue"], message: "Unknown enum default" });
    }
  } else {
    if (option.values !== undefined) {
      ctx.addIssue({ code: "custom", path: ["values"], message: "Boolean options cannot define values" });
    }
    if (option.defaultValue !== undefined && typeof option.defaultValue !== "boolean") {
      ctx.addIssue({ code: "custom", path: ["defaultValue"], message: "Boolean default must be boolean" });
    }
  }
});

const CanonicalSlashDescriptorSchema = z.object({
  id: safeReference(80),
  displayName: safeLabel(120),
  description: safeLabel(400),
  invocation: z.string().min(2).max(81).regex(/^\/[a-z][a-z0-9_-]{0,79}$/),
}).strict();

export const CanonicalChatSkillDescriptorSchema = CanonicalSlashDescriptorSchema;
export const CanonicalChatCommandDescriptorSchema = CanonicalSlashDescriptorSchema;
export const CanonicalProviderSupportSchema = z.object({
  rootChat: z.boolean(),
  resume: z.boolean(),
  cancellation: z.boolean(),
  attachments: z.array(CanonicalChatAttachmentKindSchema).max(8),
  tools: z.array(safeReference(80)).max(64),
  approvals: z.boolean(),
  userInput: z.boolean(),
  worktrees: z.enum(["none", "optional", "required"]),
  interactionModes: z.array(safeReference(80)).max(16),
  permissionModes: z.array(safeReference(80)).max(16),
}).strict().superRefine((supports, ctx) => {
  for (const key of ["attachments", "tools", "interactionModes", "permissionModes"] as const) {
    if (!unique(supports[key])) {
      ctx.addIssue({ code: "custom", path: [key], message: "Duplicate capability value" });
    }
  }
});

export const CanonicalProviderInstanceDescriptorSchema = z.object({
  id: CanonicalProviderInstanceIdSchema,
  driverKind: CanonicalProviderDriverKindSchema,
  displayName: safeLabel(160),
  availability: z.enum(["available", "setup_required", "auth_required", "unavailable"]),
  workspaceRequirement: z.enum(["none", "project_optional", "project_required"]),
  catalogRevision: safeReference(160),
  models: z.array(CanonicalModelDescriptorSchema).max(128),
  options: z.array(CanonicalProviderOptionDescriptorSchema).max(32),
  skills: z.array(CanonicalChatSkillDescriptorSchema).max(128),
  commands: z.array(CanonicalChatCommandDescriptorSchema).max(128),
  supports: CanonicalProviderSupportSchema,
  defaultSelection: CanonicalChatModelSelectionSchema.optional(),
}).strict().superRefine((instance, ctx) => {
  for (const [key, ids] of [
    ["models", instance.models.map((value) => value.id)],
    ["options", instance.options.map((value) => value.id)],
    ["skills", instance.skills.map((value) => value.id)],
    ["commands", instance.commands.map((value) => value.id)],
  ] as const) {
    if (!unique(ids)) {
      ctx.addIssue({ code: "custom", path: [key], message: `Duplicate ${key} id` });
    }
  }

  const selection = instance.defaultSelection;
  if (selection === undefined) return;
  if (selection.instanceId !== instance.id) {
    ctx.addIssue({ code: "custom", path: ["defaultSelection", "instanceId"], message: "Instance mismatch" });
  }
  const model = instance.models.find((candidate) => candidate.id === selection.model);
  if (model?.availability !== "available") {
    ctx.addIssue({ code: "custom", path: ["defaultSelection", "model"], message: "Default model unavailable" });
  }
  const selectedIds = selection.options?.map((value) => value.id) ?? [];
  if (!unique(selectedIds)) {
    ctx.addIssue({ code: "custom", path: ["defaultSelection", "options"], message: "Duplicate selection" });
  }
  for (const [index, selected] of (selection.options ?? []).entries()) {
    const descriptor = instance.options.find((candidate) => candidate.id === selected.id);
    if (descriptor === undefined) {
      ctx.addIssue({ code: "custom", path: ["defaultSelection", "options", index], message: "Unknown option" });
    } else if (descriptor.kind === "boolean" && typeof selected.value !== "boolean") {
      ctx.addIssue({ code: "custom", path: ["defaultSelection", "options", index, "value"], message: "Invalid boolean option" });
    } else if (descriptor.kind === "enum"
      && (typeof selected.value !== "string"
        || !descriptor.values?.some((candidate) => candidate.value === selected.value))) {
      ctx.addIssue({ code: "custom", path: ["defaultSelection", "options", index, "value"], message: "Invalid enum option" });
    }
  }
});

export const CanonicalProviderCatalogSchema = z.object({
  revision: safeReference(160),
  drivers: z.array(CanonicalProviderDriverDescriptorSchema).max(16),
  instances: z.array(CanonicalProviderInstanceDescriptorSchema).max(64),
}).strict().superRefine((catalog, ctx) => {
  if (!unique(catalog.drivers.map((driver) => driver.kind))) {
    ctx.addIssue({ code: "custom", path: ["drivers"], message: "Duplicate Driver" });
  }
  if (!unique(catalog.instances.map((instance) => instance.id))) {
    ctx.addIssue({ code: "custom", path: ["instances"], message: "Duplicate Instance" });
  }
  const drivers = new Set(catalog.drivers.map((driver) => driver.kind));
  catalog.instances.forEach((instance, index) => {
    if (!drivers.has(instance.driverKind)) {
      ctx.addIssue({ code: "custom", path: ["instances", index, "driverKind"], message: "Driver is not cataloged" });
    }
  });
});

export type CanonicalProviderDriverKind = z.infer<typeof CanonicalProviderDriverKindSchema>;
export type CanonicalProviderDriverDescriptor = z.infer<typeof CanonicalProviderDriverDescriptorSchema>;
export type CanonicalModelDescriptor = z.infer<typeof CanonicalModelDescriptorSchema>;
export type CanonicalProviderOptionDescriptor = z.infer<typeof CanonicalProviderOptionDescriptorSchema>;
export type CanonicalProviderSupport = z.infer<typeof CanonicalProviderSupportSchema>;
export type CanonicalProviderInstanceDescriptor = z.infer<typeof CanonicalProviderInstanceDescriptorSchema>;
export type CanonicalProviderCatalog = z.infer<typeof CanonicalProviderCatalogSchema>;
