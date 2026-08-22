import type { DesktopUpdateStatus } from "../shared/desktop-update";

interface BeforeQuitEvent {
  preventDefault(): void;
}

interface UpdateQuitDependencies {
  status(): DesktopUpdateStatus;
  isInstallStarted(): boolean;
  install(): Promise<boolean>;
  quit(): void;
  reportError(error: unknown): void;
}

export function createUpdateAwareBeforeQuit(dependencies: UpdateQuitDependencies) {
  let interceptedReadyQuit = false;

  return (event: BeforeQuitEvent): void => {
    if (
      interceptedReadyQuit ||
      dependencies.isInstallStarted() ||
      dependencies.status() !== "ready"
    ) {
      return;
    }

    event.preventDefault();
    interceptedReadyQuit = true;
    void dependencies.install()
      .then((installed) => {
        if (!installed) dependencies.quit();
      })
      .catch((error: unknown) => {
        dependencies.reportError(error);
        dependencies.quit();
      });
  };
}
