export function readBuildSource(root: string, expectedCommit?: string): {
  commit: string;
  ancestors: string[];
} | null;
export function readDesktopBuildSource(root: string, env?: {
  MATRIX_DESKTOP_SOURCE_SHA?: string;
  GITHUB_SHA?: string;
}): ReturnType<typeof readBuildSource>;
