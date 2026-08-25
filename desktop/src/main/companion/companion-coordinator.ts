import type { LocalStore } from "../persistence/local-store";
import {
  DEFAULT_COMPANION_PREFERENCES,
  type CompanionHost,
  type CompanionPreferences,
} from "../../shared/companion";
import { CompanionController } from "./companion-controller";

interface CompanionCoordinatorOptions {
  platform: NodeJS.Platform;
  rendererUrl?: string;
  preloadPath: string;
  rendererFile: string;
  store: LocalStore;
  reportError: (label: string, error: unknown) => void;
}

export class CompanionCoordinator {
  private readonly controllers: Partial<Record<CompanionHost, CompanionController>>;
  private preferences: CompanionPreferences = DEFAULT_COMPANION_PREFERENCES;

  private constructor(private readonly options: CompanionCoordinatorOptions) {
    const controllerOptions = {
      rendererUrl: options.rendererUrl,
      preloadPath: options.preloadPath,
      rendererFile: options.rendererFile,
      reportError: options.reportError,
    };
    this.controllers = {
      rabbit: new CompanionController({ host: "rabbit", ...controllerOptions }),
      ...(this.supportsNotch()
        ? { notch: new CompanionController({ host: "notch", ...controllerOptions }) }
        : {}),
    };
  }

  static async create(options: CompanionCoordinatorOptions): Promise<CompanionCoordinator> {
    const coordinator = new CompanionCoordinator(options);
    const stored = await options.store.get("companionPreferences");
    coordinator.preferences = stored ?? DEFAULT_COMPANION_PREFERENCES;
    if (!coordinator.supportsNotch() && !coordinator.preferences.rabbitEnabled) {
      coordinator.preferences = DEFAULT_COMPANION_PREFERENCES;
    }
    return coordinator;
  }

  snapshot() {
    return { preferences: this.preferences, supportsNotch: this.supportsNotch() };
  }

  showEnabled(): void {
    this.apply(this.preferences);
  }

  async setPreferences(preferences: CompanionPreferences): Promise<void> {
    if (!this.supportsNotch() && !preferences.rabbitEnabled) {
      throw new Error("invalid companion preference");
    }
    await this.options.store.set("companionPreferences", preferences);
    this.preferences = preferences;
    this.apply(preferences);
  }

  setExpanded(host: CompanionHost, expanded: boolean): void {
    this.controllers[host]?.setExpanded(expanded);
  }

  hide(host: CompanionHost): void {
    this.controllers[host]?.hide();
  }

  toggleEnabled(): void {
    const controllers = this.enabledControllers();
    const shouldShow = controllers.every((controller) => !controller.isVisible());
    for (const controller of controllers) {
      if (shouldShow) controller.show();
      else controller.hide();
    }
  }

  close(): void {
    for (const controller of Object.values(this.controllers)) controller?.close();
  }

  private supportsNotch(): boolean {
    return this.options.platform === "darwin";
  }

  private enabledControllers(): CompanionController[] {
    return [
      ...(this.preferences.rabbitEnabled ? [this.controllers.rabbit] : []),
      ...(this.preferences.notchEnabled ? [this.controllers.notch] : []),
    ].filter((controller): controller is CompanionController => Boolean(controller));
  }

  private apply(preferences: CompanionPreferences): void {
    const enabled: Record<CompanionHost, boolean> = {
      rabbit: preferences.rabbitEnabled,
      notch: preferences.notchEnabled && this.supportsNotch(),
    };
    for (const host of ["rabbit", "notch"] as const) {
      if (enabled[host]) this.controllers[host]?.show();
      else this.controllers[host]?.hide();
    }
  }
}
