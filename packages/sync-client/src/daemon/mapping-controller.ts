import { z } from "zod/v4";
import {
  SyncMappingConfigSchema,
  SyncMappingSchema,
  type SyncMappingConfig,
} from "@matrix-os/contracts";

const RevisionSchema = z.int().nonnegative();
const MappingIdSchema = z.uuid();
const AddArgsSchema = z.object({
  expectedRevision: RevisionSchema,
  mapping: SyncMappingSchema,
}).strict();
const MutationArgsSchema = z.object({
  expectedRevision: RevisionSchema,
  mappingId: MappingIdSchema,
}).strict();
const RescanArgsSchema = z.object({ mappingId: MappingIdSchema.optional() }).strict();

export interface MappingControllerDeps {
  snapshot: () => SyncMappingConfig;
  commit: (next: SyncMappingConfig, expectedRevision: number) => Promise<void>;
  validate?: (next: SyncMappingConfig) => Promise<void>;
  rescan?: (mappingId?: string) => Promise<void>;
  conflicts?: (mappingId?: string) => unknown[];
}

function codedError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

function parse<T extends z.ZodType>(schema: T, args: Record<string, unknown>): z.infer<T> {
  const parsed = schema.safeParse(args);
  if (!parsed.success) throw codedError("invalid_request");
  return parsed.data;
}

export function createMappingControllerHandler(deps: MappingControllerDeps): (
  command: string,
  args: Record<string, unknown>,
) => Promise<Record<string, unknown>> {
  const mutate = async (
    expectedRevision: number,
    update: (current: SyncMappingConfig) => SyncMappingConfig,
  ): Promise<Record<string, unknown>> => {
    const current = deps.snapshot();
    if (current.revision !== expectedRevision) {
      throw codedError("sync_config_revision_conflict");
    }
    const next = SyncMappingConfigSchema.parse({
      ...update(current),
      revision: current.revision + 1,
    });
    await deps.validate?.(next);
    await deps.commit(next, expectedRevision);
    return { config: next };
  };

  return async (command, args) => {
    switch (command) {
      case "sync.mappings.list":
        return { config: deps.snapshot() };
      case "sync.mappings.add": {
        const parsed = parse(AddArgsSchema, args);
        return mutate(parsed.expectedRevision, (current) => {
          if (current.mappings.some((mapping) => mapping.id === parsed.mapping.id)) {
            throw codedError("sync_mapping_exists");
          }
          return { ...current, mappings: [...current.mappings, parsed.mapping] };
        });
      }
      case "sync.mappings.pause":
      case "sync.mappings.resume":
      case "sync.mappings.remove": {
        const parsed = parse(MutationArgsSchema, args);
        return mutate(parsed.expectedRevision, (current) => {
          const index = current.mappings.findIndex((mapping) => mapping.id === parsed.mappingId);
          if (index < 0) throw codedError("sync_mapping_not_found");
          if (command === "sync.mappings.remove") {
            return {
              ...current,
              mappings: current.mappings.filter((mapping) => mapping.id !== parsed.mappingId),
            };
          }
          const mappings = [...current.mappings];
          mappings[index] = {
            ...mappings[index]!,
            enabled: command === "sync.mappings.resume",
          };
          return { ...current, mappings };
        });
      }
      case "sync.mappings.rescan": {
        const parsed = parse(RescanArgsSchema, args);
        if (!deps.rescan) throw codedError("sync_rescan_unavailable");
        await deps.rescan(parsed.mappingId);
        return { accepted: true };
      }
      case "sync.mappings.conflicts": {
        const parsed = parse(RescanArgsSchema, args);
        return { conflicts: (deps.conflicts?.(parsed.mappingId) ?? []).slice(0, 500) };
      }
      default:
        throw codedError("unknown_command");
    }
  };
}
