export async function runBestEffortTerminalShutdown(
  shutdown: () => Promise<void>,
  log: (message: string, errorType: string) => void = console.warn,
): Promise<void> {
  try {
    await shutdown();
  } catch (error: unknown) {
    log(
      "[terminal-runtime] graceful shutdown incomplete:",
      error instanceof Error ? error.name : "UnknownError",
    );
  }
}
