interface BeforeQuitEvent {
  preventDefault(): void;
}

interface AnalyticsQuitDependencies {
  requestFlush(): Promise<void>;
  quit(): void;
  timeoutMs: number;
}

export function createAnalyticsBeforeQuit(dependencies: AnalyticsQuitDependencies) {
  let intercepted = false;

  return (event: BeforeQuitEvent): boolean => {
    if (intercepted) return false;
    intercepted = true;
    event.preventDefault();

    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => {
      timeoutId = setTimeout(resolve, dependencies.timeoutMs);
    });
    void Promise.race([
      dependencies.requestFlush().catch(() => undefined),
      timeout,
    ]).finally(() => {
      if (timeoutId) clearTimeout(timeoutId);
      dependencies.quit();
    });
    return true;
  };
}
