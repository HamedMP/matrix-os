interface GatewayShutdownDependencies {
  process: Pick<NodeJS.Process, "on" | "off" | "exit">;
  disposeProcessErrors(): void;
  closeGateway(): Promise<void>;
  shutdownTelemetry(): Promise<void>;
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
      console.warn("[gateway] Graceful shutdown failed", error instanceof Error ? "error" : "non-error");
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
