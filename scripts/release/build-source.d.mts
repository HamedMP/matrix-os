export function readBuildSource(root: string, expectedCommit?: string): {
  commit: string;
  ancestors: string[];
} | null;
