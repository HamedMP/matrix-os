import { z } from 'zod/v4';
import { DevstackClerkUserIdSchema, DevstackContainerIdSchema, DevstackInstanceSchema } from '../devstack-identity.js';
import { HANDLE_PATTERN } from '../platform-route-utils.js';

const httpsOrigin = z.string().max(512).refine(value => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.origin === value && url.pathname === '/' && !url.search && !url.hash;
  } catch (error: unknown) {
    if (!(error instanceof TypeError)) throw error;
    return false;
  }
});

const targetSchema = z.strictObject({
  runtime: DevstackInstanceSchema,
  worktree: DevstackInstanceSchema,
  owner: DevstackClerkUserIdSchema,
  handle: z.string().regex(HANDLE_PATTERN),
  containerId: DevstackContainerIdSchema,
  cwd: z.string().max(240).regex(/^projects(?:\/[a-zA-Z0-9_-][a-zA-Z0-9_.-]{0,62})+$/),
  revision: z.string().regex(/^[a-f0-9]{40}$/),
});
const configSchema = z.strictObject({
  issuer: httpsOrigin,
  previewOrigin: httpsOrigin,
  operators: z.array(DevstackClerkUserIdSchema).min(1).max(3),
  targets: z.array(targetSchema).min(1).max(24),
});

const previewTargetSchema = targetSchema.pick({ runtime: true, worktree: true, owner: true, handle: true, containerId: true });
const previewConfigSchema = configSchema.extend({ targets: z.array(previewTargetSchema).min(1).max(24) });

export type DevstackPreviewTarget = z.infer<typeof previewTargetSchema>;
export type DevstackPreviewConfig = z.infer<typeof previewConfigSchema> & { instance: string };

export type DevstackRunTarget = z.infer<typeof targetSchema>;
export type DevstackRunConfig = z.infer<typeof configSchema> & { instance: string };

export class DevstackRunConfigError extends Error {
  constructor(kind: 'run' | 'preview' = 'run') {
    super(`DevStack ${kind} configuration is invalid or registered-runtime routing is disabled.`);
  }
}

function parseDevstackConfig<T>(
  raw: string | undefined, instance: string | undefined, schema: z.ZodType<T>, kind: 'run' | 'preview',
): (T & { instance: string }) | undefined {
  if (raw === undefined) return undefined;
  if (!instance || !DevstackInstanceSchema.safeParse(instance).success || Buffer.byteLength(raw) > 16 * 1024) {
    throw new DevstackRunConfigError(kind);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error: unknown) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new DevstackRunConfigError(kind);
  }
  const result = schema.safeParse(parsed);
  if (!result.success) throw new DevstackRunConfigError(kind);
  return { ...result.data, instance };
}

export function loadDevstackPreviewConfig(raw: string | undefined, instance: string | undefined): DevstackPreviewConfig | undefined {
  const config = parseDevstackConfig(raw, instance, previewConfigSchema, 'preview');
  if (!config) return undefined;
  const { operators, targets } = config;
  // A canonical preview path serves one checkout. Never offer two selections
  // that would send the owner to the same registered runtime.
  if (new Set(operators).size !== operators.length || new Set(targets.map(target => target.runtime)).size !== targets.length
    || new Set(targets.map(target => target.handle)).size !== targets.length
    || new Set(targets.map(target => target.containerId)).size !== targets.length
    || targets.some(target => !operators.includes(target.owner) || Object.values(target).some(value => value.includes('\n')))) {
    throw new DevstackRunConfigError('preview');
  }
  return config;
}

export function loadDevstackRunConfig(raw: string | undefined, instance: string | undefined): DevstackRunConfig | undefined {
  const config = parseDevstackConfig(raw, instance, configSchema, 'run');
  if (!config) return undefined;
  const { operators, targets } = config;
  if (new Set(operators).size !== operators.length) throw new DevstackRunConfigError();

  const bindings = new Map<string, DevstackRunTarget>();
  const selections = new Set<string>();
  const directories = new Set<string>();
  for (const target of targets) {
    const binding = bindings.get(target.runtime);
    const selection = target.runtime + '/' + target.worktree;
    const directory = target.containerId + '/' + target.cwd;
    if (!operators.includes(target.owner) || selections.has(selection) || directories.has(directory)
      || [target.runtime, target.worktree, target.owner, target.handle, target.containerId, target.cwd, target.revision]
        .some(value => value.includes('\n'))
      || (binding && (binding.handle !== target.handle || binding.owner !== target.owner || binding.containerId !== target.containerId))) {
      throw new DevstackRunConfigError();
    }
    bindings.set(target.runtime, target);
    selections.add(selection);
    directories.add(directory);
  }
  return config;
}
