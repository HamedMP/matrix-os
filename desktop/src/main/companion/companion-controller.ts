import { BrowserWindow, screen } from "electron";
import {
  companionWindowBounds,
  companionWindowOptions,
  RABBIT_COLLAPSED_SIZE,
  RABBIT_EXPANDED_SIZE,
} from "./companion-window";

interface CompanionControllerOptions {
  rendererUrl?: string;
  preloadPath: string;
  rendererFile: string;
  reportError: (label: string, error: unknown) => void;
}

export class CompanionController {
  private window: BrowserWindow | null = null;

  constructor(private readonly options: CompanionControllerOptions) {}

  show(): void {
    if (this.window && !this.window.isDestroyed()) {
      this.window.showInactive();
      return;
    }

    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const bounds = companionWindowBounds(display.workArea, RABBIT_COLLAPSED_SIZE);
    const window = new BrowserWindow(
      companionWindowOptions(process.platform, bounds, this.options.preloadPath),
    );
    this.window = window;

    window.setAlwaysOnTop(true, "floating");
    window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    window.once("ready-to-show", () => window.showInactive());
    window.on("closed", () => {
      if (this.window === window) this.window = null;
    });

    if (this.options.rendererUrl) {
      const url = new URL(this.options.rendererUrl);
      url.searchParams.set("surface", "companion");
      void window.loadURL(url.toString()).catch((error: unknown) => {
        this.options.reportError("failed to load companion renderer URL", error);
      });
    } else {
      void window.loadFile(this.options.rendererFile, {
        query: { surface: "companion" },
      }).catch((error: unknown) => {
        this.options.reportError("failed to load companion renderer file", error);
      });
    }
  }

  setExpanded(expanded: boolean): void {
    const window = this.window;
    if (!window || window.isDestroyed()) return;
    const display = screen.getDisplayMatching(window.getBounds());
    const size = expanded ? RABBIT_EXPANDED_SIZE : RABBIT_COLLAPSED_SIZE;
    window.setBounds(companionWindowBounds(display.workArea, size), process.platform === "darwin");
    if (expanded) {
      window.show();
      window.focus();
    }
  }

  hide(): void {
    if (this.window && !this.window.isDestroyed()) this.window.hide();
  }

  toggle(): void {
    if (!this.window || this.window.isDestroyed() || !this.window.isVisible()) {
      this.show();
      return;
    }
    this.hide();
  }

  close(): void {
    if (this.window && !this.window.isDestroyed()) this.window.destroy();
    this.window = null;
  }
}
