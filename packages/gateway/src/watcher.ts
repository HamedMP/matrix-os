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

export function createWatcher(homePath: string): Watcher {
  const listeners: Array<(event: FileChangeEvent) => void> = [];

  // chokidar v4 dropped FSEvents support and uses macOS fs.watch (kqueue),
  // which opens one descriptor per watched path. On a populated matrix home
  // (apps/, projects/, sessions/, etc.) the recursive watch exhausts the
  // per-process kqueue limit and crashes the gateway with EMFILE before it
  // ever finishes binding the port. Polling is slower but bounded -- on a
  // dev workstation the CPU cost is negligible compared to losing the
  // gateway entirely.
  const fsWatcher: FSWatcher = watch(homePath, {
    ignoreInitial: true,
    usePolling: true,
    interval: 1000,
    binaryInterval: 2000,
    ignored: [
      "**/node_modules/**",
      "**/.git/**",
      "**/.next/**",
      "**/.turbo/**",
      "**/.cache/**",
      "**/.trash/**",
      "**/dist/**",
      "**/build/**",
      "**/system/matrix.db*",
    ],
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
