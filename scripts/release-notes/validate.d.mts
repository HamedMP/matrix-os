export function validateReleaseNotesDirectory(dir: string): Promise<{
  files: string[];
  errors: string[];
}>;
