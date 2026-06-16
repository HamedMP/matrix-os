import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

interface VersionLogger {
  warn(message: string, detail: string): void;
}

export function resolveCliVersion(): string {
  if (process.env.MATRIX_CLI_VERSION) {
    return process.env.MATRIX_CLI_VERSION;
  }

  return resolveCliVersionFromPackage(
    () => require("../../package.json") as { version?: string },
    console,
  );
}

export function resolveCliVersionFromPackage(
  readPackageJson: () => { version?: string },
  logger: VersionLogger,
): string {
  try {
    const pkg = readPackageJson();
    return typeof pkg.version === "string" && pkg.version.length > 0 ? pkg.version : "0.0.0";
  } catch (err) {
    logger.warn(
      "[cli/version] failed to read package version:",
      err instanceof Error ? err.message : String(err),
    );
    return "0.0.0";
  }
}
