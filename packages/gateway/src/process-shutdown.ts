interface GatewayShutdownDependencies {
  process: Pick<NodeJS.Process, "on" | "off" | "exit">;
  disposeProcessErrors(): void;
  closeGateway(): Promise<void>;
  shutdownTelemetry(): Promise<void>;
}

/**
 * What a failed shutdown logs: the error's name and its code when it has a plain one (ERR_SERVER_NOT_RUNNING,
 * ECONNRESET, a SQLSTATE), never its message, which can carry paths or provider text.
 */
export function shutdownFailure(error: unknown): string[] {
  if (!(error instanceof Error)) return ["non-error"];
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && /^[A-Za-z0-9_]{1,64}$/.test(code) ? [error.name, code] : [error.name];
}

/** One graceful path for terminal interrupts and host-service/Docker termination. */
export function registerGatewayShutdown(deps: GatewayShutdownDependencies): () => void {
  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    try {
      deps.disposeProcessErrors();
      await deps.closeGateway();
      await deps.shutdownTelemetry();
      deps.process.exit(0);
    } catch (error: unknown) {
      console.warn("[gateway] Graceful shutdown failed:", ...shutdownFailure(error));
      deps.process.exit(1);
    }
  };
  const handleSignal = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    void shutdown();
  };
  deps.process.on("SIGINT", handleSignal);
  deps.process.on("SIGTERM", handleSignal);
  return () => {
    deps.process.off("SIGINT", handleSignal);
    deps.process.off("SIGTERM", handleSignal);
  };
}
