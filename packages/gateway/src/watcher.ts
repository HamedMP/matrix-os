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

export function createWatcherIgnoredGlobs(
  options: WatcherIgnoredGlobsOptions = {},
): string[] {
  return [
    ...ALWAYS_IGNORED_GLOBS,
    ...(options.watchProjects ? [] : DEFAULT_PROJECT_IGNORED_GLOBS),
  ];
}

export function createWatcher(homePath: string): Watcher {
  const listeners: Array<(event: FileChangeEvent) => void> = [];

  // chokidar v4 uses fs.watch which on macOS (kqueue) opens one FD per
  // path and hits EMFILE on large trees. On Linux, inotify avoids
  // per-file FDs but still walks every directory to set up watches —
  // with a large MATRIX_HOME containing projects/node_modules this
  // exhausts memory. Polling is bounded and predictable on both.
  const fsWatcher: FSWatcher = watch(homePath, {
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
