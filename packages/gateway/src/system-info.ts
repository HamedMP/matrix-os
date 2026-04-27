import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const startTime = Date.now();

function logSystemInfoReadFailure(context: string, err: unknown): void {
  console.warn(
    `[system-info] ${context}:`,
    err instanceof Error ? err.message : String(err),
  );
}

function isMissingFileError(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === "ENOENT";
}

export function getVersion(): string {
  try {
    return readFileSync("/app/VERSION", "utf-8").trim();
  } catch (err) {
    if (!isMissingFileError(err)) {
      logSystemInfoReadFailure("Failed to read /app/VERSION", err);
    }
  }
  try {
    const pkg = JSON.parse(
      readFileSync(
        join(import.meta.dirname, "..", "..", "..", "package.json"),
        "utf-8",
      ),
    );
    return pkg.version ?? "0.0.0";
  } catch (err) {
    logSystemInfoReadFailure("Failed to read package.json version", err);
  }
  return "0.0.0";
}

export interface SystemInfo {
  version: string;
  image: string;
  build: {
    sha: string;
    ref: string;
    date: string;
  };
  uptime: number;
  modules: number;
  channels: Record<string, boolean>;
  skills: number;
  templateVersion: string;
  installedVersion: string;
}

export function getSystemInfo(homePath: string): SystemInfo {
  let modules = 0;
  const modulesPath = join(homePath, "system", "modules.json");
  if (existsSync(modulesPath)) {
    try {
      const data = JSON.parse(readFileSync(modulesPath, "utf-8"));
      modules = Array.isArray(data) ? data.length : 0;
    } catch (err) {
      logSystemInfoReadFailure("Failed to read modules", err);
    }
  }

  const channels: Record<string, boolean> = {};
  const configPath = join(homePath, "system", "config.json");
  if (existsSync(configPath)) {
    try {
      const cfg = JSON.parse(readFileSync(configPath, "utf-8"));
      if (cfg.channels) {
        for (const [id, conf] of Object.entries(cfg.channels)) {
          channels[id] = (conf as { enabled?: boolean }).enabled ?? false;
        }
      }
    } catch (err) {
      logSystemInfoReadFailure("Failed to read channel config", err);
    }
  }

  let skills = 0;
  const skillsDir = join(homePath, "agents", "skills");
  if (existsSync(skillsDir)) {
    try {
      skills = readdirSync(skillsDir).filter((f) => f.endsWith(".md")).length;
    } catch (err) {
      logSystemInfoReadFailure("Failed to count skills", err);
    }
  }

  let templateVersion = "unknown";
  const templateVersionPath = resolve(
    import.meta.dirname, "..", "..", "..", "home", ".matrix-version",
  );
  try {
    if (existsSync(templateVersionPath)) {
      templateVersion = readFileSync(templateVersionPath, "utf-8").trim();
    }
  } catch (err) {
    logSystemInfoReadFailure("Failed to read template version", err);
  }

  let installedVersion = "unknown";
  const installedVersionPath = join(homePath, ".matrix-version");
  try {
    if (existsSync(installedVersionPath)) {
      installedVersion = readFileSync(installedVersionPath, "utf-8").trim();
    }
  } catch (err) {
    logSystemInfoReadFailure("Failed to read installed version", err);
  }

  return {
    version: getVersion(),
    image: process.env.MATRIX_IMAGE ?? "unknown",
    build: {
      sha: process.env.MATRIX_BUILD_SHA ?? "unknown",
      ref: process.env.MATRIX_BUILD_REF ?? "unknown",
      date: process.env.MATRIX_BUILD_DATE ?? "unknown",
    },
    uptime: Math.floor((Date.now() - startTime) / 1000),
    modules,
    channels,
    skills,
    templateVersion,
    installedVersion,
  };
}
