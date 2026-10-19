export function readBuildSource(root: string, expectedCommit?: string): {
  commit: string;
  ancestors: string[];
} | null;

export function readDesktopBuildSource(root: string, env?: Record<string, string | undefined>): ReturnType<typeof readBuildSource>;
