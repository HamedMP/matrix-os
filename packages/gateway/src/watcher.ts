import { join } from "node:path";
import { watch, type FSWatcher } from "chokidar";

export type FileEvent = "add" | "change" | "unlink";

export interface FileChangeEvent {
  type: "file:change";
  path: string;
  event: FileEvent;
}

export interface Watcher {
  on(listener: (event: FileChangeEvent) => void): void;
  close(): Promise<void>;
}

export interface WatcherIgnoredGlobsOptions {
  watchProjects?: boolean;
}

const ALWAYS_IGNORED_GLOBS = [
  "**/node_modules/**",
  "**/.git/**",
  "**/.next/**",
  "**/.turbo/**",
  "**/.cache/**",
  "**/.trash/**",
  "**/dist/**",
  "**/build/**",
  "**/system/matrix.db*",
  "**/.claude/**",
  "**/.codex/**",
  "**/.hermes/**",
  "**/.local/**",
  "**/.npm/**",
];

const DEFAULT_PROJECT_IGNORED_GLOBS = [
  "**/projects/**",
  "**/matrix-os/**",
];

const WATCHED_HOME_DIRECTORIES = [
  "agents",
  "apps",
  "data",
  "modules",
  "plugins",
  "sessions",
  "system",
  "templates",
  "themes",
  "tools",
];

const WATCHED_HOME_FILES = [
  ".matrix-version",
  ".syncignore",
  ".template-manifest.json",
  "CLAUDE.md",
];

export function createWatcherIgnoredGlobs(
  options: WatcherIgnoredGlobsOptions = {},
): string[] {
  return [
    ...ALWAYS_IGNORED_GLOBS,
    ...(options.watchProjects ? [] : DEFAULT_PROJECT_IGNORED_GLOBS),
  ];
}

export function createWatcherPaths(homePath: string): string[] {
  return [
    ...WATCHED_HOME_DIRECTORIES.map((entry) => join(homePath, entry)),
    ...WATCHED_HOME_FILES.map((entry) => join(homePath, entry)),
  ];
}

export function createWatcher(homePath: string): Watcher {
  const listeners: Array<(event: FileChangeEvent) => void> = [];

  // Watch Matrix-owned home roots explicitly. Watching the whole home and
  // relying on ignores still lets chokidar traverse large user/project trees
  // during startup on customer VPSes.
  const fsWatcher: FSWatcher = watch(createWatcherPaths(homePath), {
    ignoreInitial: true,
    usePolling: true,
    interval: 2000,
    binaryInterval: 5000,
    ignored: createWatcherIgnoredGlobs({
      watchProjects: process.env.MATRIX_WATCH_PROJECTS === "true",
    }),
  });

  const emit = (event: FileEvent, path: string) => {
    const relative = path.startsWith(homePath)
      ? path.slice(homePath.length + 1)
      : path;
    const change: FileChangeEvent = { type: "file:change", path: relative, event };
    for (const listener of listeners) {
      listener(change);
    }
  };

  fsWatcher.on("add", (path) => emit("add", path));
  fsWatcher.on("change", (path) => emit("change", path));
  fsWatcher.on("unlink", (path) => emit("unlink", path));

  return {
    on(listener) {
      listeners.push(listener);
    },
    async close() {
      await fsWatcher.close();
    },
  };
}
