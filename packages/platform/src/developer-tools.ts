import { z } from 'zod/v4';
import { getMatrixDeveloperToolPreinstallLimit } from '@matrix-os/contracts';

export const DEVELOPER_TOOL_IDS = ['codex', 'claude-code', 'opencode', 'pi'] as const;
export type DeveloperToolId = (typeof DEVELOPER_TOOL_IDS)[number];

export const DEFAULT_DEVELOPER_TOOLS: DeveloperToolId[] = [...DEVELOPER_TOOL_IDS];

export const DeveloperToolIdSchema = z.enum(DEVELOPER_TOOL_IDS);

export function canonicalizeDeveloperTools(input: readonly DeveloperToolId[]): DeveloperToolId[] {
  const selected = new Set(input);
  return DEVELOPER_TOOL_IDS.filter((tool) => selected.has(tool));
}

export function developerToolsAllowedForServerType(
  serverType: string,
  developerTools: readonly DeveloperToolId[],
): boolean {
  const limit = getMatrixDeveloperToolPreinstallLimit(serverType);
  return limit === null || canonicalizeDeveloperTools(developerTools).length <= limit;
}

export function defaultDeveloperToolsForServerType(serverType: string): DeveloperToolId[] {
  const limit = getMatrixDeveloperToolPreinstallLimit(serverType);
  return limit === null ? [...DEFAULT_DEVELOPER_TOOLS] : DEFAULT_DEVELOPER_TOOLS.slice(0, limit);
}

export const DeveloperToolsSchema = z
  .array(DeveloperToolIdSchema)
  .max(DEVELOPER_TOOL_IDS.length)
  .transform(canonicalizeDeveloperTools);

export const DeveloperToolsWithDefaultSchema = z.preprocess(
  (value) => value === undefined ? DEFAULT_DEVELOPER_TOOLS : value,
  DeveloperToolsSchema,
);

export function resolveProvisioningDeveloperTools(
  explicitSelection: readonly DeveloperToolId[] | undefined,
  settlingCheckoutSelection: readonly DeveloperToolId[] | undefined,
): DeveloperToolId[] {
  return canonicalizeDeveloperTools(
    explicitSelection !== undefined
      ? explicitSelection
      : settlingCheckoutSelection ?? DEFAULT_DEVELOPER_TOOLS,
  );
}

export function serializeDeveloperTools(input: readonly DeveloperToolId[] = DEFAULT_DEVELOPER_TOOLS): string {
  return JSON.stringify(canonicalizeDeveloperTools(input));
}

export function parseDeveloperToolsJson(value: string | null | undefined): DeveloperToolId[] {
  if (!value) return DEFAULT_DEVELOPER_TOOLS;
  try {
    return DeveloperToolsSchema.parse(JSON.parse(value));
  } catch (err: unknown) {
    if (err instanceof SyntaxError || err instanceof z.ZodError) {
      return DEFAULT_DEVELOPER_TOOLS;
    }
    throw err;
  }
}

export function developerToolsShellList(input: readonly DeveloperToolId[]): string {
  return canonicalizeDeveloperTools(input).join(' ');
}
