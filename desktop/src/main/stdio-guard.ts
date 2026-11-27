// The main process logs with console.*, which writes to stdout/stderr. When the
// reader of those pipes goes away first (a closed terminal, or a test runner
// that exited before Electron), the next write fails with EPIPE. With no
// "error" listener that becomes an uncaught exception and Electron shows a
// crash dialog. A closed log pipe must never take the app down.

interface ErrorEmitter {
  on(event: "error", listener: (error: Error) => void): unknown;
}

const BROKEN_PIPE_CODES = new Set(["EPIPE", "EBADF"]);
const guarded = new WeakSet<object>();

function isBrokenPipe(error: unknown): boolean {
  return error instanceof Error && "code" in error && typeof error.code === "string" && BROKEN_PIPE_CODES.has(error.code);
}

function rethrowUncaught(error: Error): void {
  // Any other stream failure keeps its previous behavior: an uncaught exception.
  queueMicrotask(() => { throw error; });
}

export function installBrokenPipeGuard(
  streams: readonly ErrorEmitter[],
  options: { rethrow?: (error: Error) => void } = {},
): void {
  const rethrow = options.rethrow ?? rethrowUncaught;
  for (const stream of streams) {
    if (guarded.has(stream)) continue;
    guarded.add(stream);
    // Nothing is logged for a broken pipe: the log destination is the thing that broke.
    stream.on("error", (error) => {
      if (!isBrokenPipe(error)) rethrow(error);
    });
  }
}
