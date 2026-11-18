import type { WebContents } from "electron";
import type { HostedBotsAppearance } from "../../shared/hosted-bots-appearance";
import { HOSTED_BOTS_ORIGIN } from "./hosted-bots-transport";

export function createHostedBotsAppearanceController(contents: WebContents, initial: HostedBotsAppearance) {
  let appearance = initial;

  function apply(): void {
    if (contents.isDestroyed() || !URL.canParse(contents.getURL())
      || new URL(contents.getURL()).origin !== HOSTED_BOTS_ORIGIN) return;

    const { mode, background, sidebar, surface, raised, sunken, overlay, hover, border,
      foreground, muted, accent, accentText, onAccent, focus, success, onSuccess,
      danger, onDanger, warning } = appearance;
    const skin = mode === "light" ? "daylight" : "midnight";
    const colors = {
      "--color-app": background,
      "--color-panel": sidebar,
      "--color-frame": sidebar,
      "--color-card": surface,
      "--color-raised": raised,
      "--color-raised-hover": hover,
      "--color-composer": background,
      "--color-composer-ring": border,
      "--color-menu": overlay,
      "--color-menu-hover": hover,
      "--color-menu-active": hover,
      "--color-inset": sunken,
      "--color-control": raised,
      "--color-hairline": border,
      "--color-edge": border,
      "--color-ink": foreground,
      "--color-ink-secondary": muted,
      "--color-ink-tertiary": muted,
      "--color-accent": accent,
      "--color-accent-border": accent,
      "--color-accent-text": accentText,
      "--color-accent-ink": onAccent,
      "--color-focus": focus,
      "--color-bubble-user": accent,
      "--color-bubble-user-ink": onAccent,
      "--color-success": success,
      "--color-success-ink": onSuccess,
      "--color-danger": danger,
      "--color-danger-ink": onDanger,
      "--color-warning": warning,
      "--color-scrollbar": border,
      "--color-maus-line": foreground,
    };

    // The code is fixed. The isolated world receives only JSON-escaped palette
    // values, and the document rechecks its origin in case navigation raced.
    const code = `(() => {
      if (document.location.origin !== ${JSON.stringify(HOSTED_BOTS_ORIGIN)}) return;
      const root = document.documentElement;
      if (!root) return;
      if (!root.hasAttribute("data-matrix-bots-skin")) {
        // The upstream app may repaint its saved or system skin after startup.
        new MutationObserver(() => {
          if (root.dataset.skin !== root.dataset.matrixBotsSkin) root.dataset.skin = root.dataset.matrixBotsSkin;
        }).observe(root, { attributes: true, attributeFilter: ["data-skin"] });
      }
      root.dataset.matrixBotsSkin = ${JSON.stringify(skin)};
      root.dataset.skin = root.dataset.matrixBotsSkin;
      root.style.colorScheme = ${JSON.stringify(mode)};
      root.style.setProperty("--code-color-scheme", ${JSON.stringify(mode)});
      for (const [token, color] of Object.entries(${JSON.stringify(colors)})) {
        if (CSS.supports("color", color)) root.style.setProperty(token, color);
      }
    })()`;
    void contents.executeJavaScriptInIsolatedWorld(1001, [{ code }]).catch((error: unknown) => {
      if (!contents.isDestroyed()) {
        console.warn("[hosted-bots-embed] Appearance sync failed", error instanceof Error ? error.name : "UnknownError");
      }
    });
  }

  contents.on("dom-ready", apply);
  return {
    update(next: HostedBotsAppearance): void {
      appearance = next;
      apply();
    },
  };
}
