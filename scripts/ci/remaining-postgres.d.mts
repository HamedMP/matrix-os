export interface RemainingPostgresInventory {
  files: string[];
  requirements: Array<{ file: string; environments: string[]; factories: string[] }>;
  existingHostedOverlaps: string[];
  legacyEnvironment: Record<string, string>;
}
export const REMAINING_POSTGRES_FILES: string[];
export function remainingPostgresInventory(root?: string, files?: string[]): RemainingPostgresInventory;
export function runRemainingPostgres(
  root?: string,
  env?: Record<string, string | undefined>,
  execute?: (command: string, args: string[], options: unknown) => { status: number | null; signal?: string | null; error?: Error },
  output?: string,
  files?: string[],
  now?: () => number,
): number;
