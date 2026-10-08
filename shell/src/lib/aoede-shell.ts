/**
 * Shell composition for the standalone Aoede workspace assistant
 * (specs/535-aoede-rewrite). Owns the constants shared by the launcher icon,
 * command-palette action and the singleton host: which OS-view surface maps to
 * which contract surface, how the owner identity is composed, when entry
 * points are supported, and how canonical history/results navigate to real
 * shell destinations.
 *
 * Aoede is deliberately NOT an OS window: "__aoede__" is a retired built-in
 * path so no surface can ever open a second instance, while the shell-level
 * host reveals/focuses the one shared assistant.
 */
import type { DesktopMode } from "@/stores/desktop-mode";
import { useDesktopMode } from "@/stores/desktop-mode";
import { useDesktopConfigStore } from "@/stores/desktop-config";
import { useCommandStore } from "@/stores/commands";
import { useWindowManager } from "@/hooks/useWindowManager";
import { useCanvasTransform } from "@/hooks/useCanvasTransform";
import { usePreviewWindow } from "@/hooks/usePreviewWindow";
import { isRetiredBuiltInAppPath, normalizeBuiltInAppPath } from "@/lib/builtin-apps";
import { voiceMediaSupported, createVoiceSessionFetcher } from "@/lib/voice-session-client";
import { safeAoedeArtifactPath } from "@matrix-os/ui/aoede";

/** Pseudo app path for the standalone assistant. Never a real window. */
export const AOEDE_APP_PATH = "__aoede__";
/** Command-palette entry id for the assistant launcher action. */
export const AOEDE_COMMAND_ID = "app:__aoede__";

export type AoedeShellSurface = "web_canvas" | "web_desktop";

/** Maps the shell OS view to the contract surface reported at bootstrap. */
export function aoedeSurfaceForDesktopMode(mode: DesktopMode): AoedeShellSurface {
  return mode === "canvas" ? "web_canvas" : "web_desktop";
}

/**
 * Immutable assistant identity: authenticated owner + explicit runtime.
 * Canvas/Desktop is mutable presentation context, so switching OS views keeps
 * the same controller, canonical conversation and media owner.
 */
export function aoedeIdentityKey(input: {
  userId?: string | null;
  runtimeSlot?: string | null;
}): string {
  return [
    "aoede",
    input.userId?.trim() || "anonymous",
    input.runtimeSlot?.trim() || "default",
  ].join(":");
}

/**
 * Aoede is supported on the web Canvas/Desktop surfaces only. The phone-width
 * mobile shell has no contract surface, and without mic capture capability
 * the assistant could never listen — entry points stay hidden, not broken.
 */
export function aoedeEntrySupported(
  isMobileViewport: boolean,
  mediaSupported: boolean = voiceMediaSupported(),
): boolean {
  return !isMobileViewport && mediaSupported;
}

let sharedAoedeFetcher: typeof fetch | null = null;

/**
 * The one fetch the assistant uses for bootstrap, canonical detail/events and
 * voice-session calls. The voice-session fetcher already bounds timeouts at
 * call sites and absolutizes relayed transport grant URLs onto the current
 * gateway origin; every other path passes through untouched.
 */
export function getAoedeShellFetcher(): typeof fetch {
  if (!sharedAoedeFetcher) sharedAoedeFetcher = createVoiceSessionFetcher();
  return sharedAoedeFetcher;
}

export function resetAoedeShellFetcherForTests(): void {
  sharedAoedeFetcher = null;
}

/** Dock x-offset the Desktop uses for new windows (dock on the left eats space). */
function shellDockXOffset(): number {
  const dock = useDesktopConfigStore.getState().dock;
  return dock.position === "left" ? dock.size + 16 : 20;
}

function findWindowByPath(path: string) {
  return useWindowManager
    .getState()
    .windows.find((w) => w.path === path || w.path.startsWith(`${path}:`));
}

/** In canvas mode, pan so the revealed window is centered — mirrors Desktop. */
function panCanvasToWindow(path: string): void {
  if (useDesktopMode.getState().mode !== "canvas") return;
  requestAnimationFrame(() => {
    const win = findWindowByPath(path);
    if (!win || win.minimized) return;
    const rect = useCanvasTransform.getState().containerRect;
    useCanvasTransform
      .getState()
      .focusOnWindow(
        win,
        rect?.width ?? window.innerWidth,
        rect?.height ?? window.innerHeight,
      );
  });
}

// A registered command must never route back into a reveal (a stray
// "app:<path>" entry that itself calls the launch dispatcher would loop).
// Reentrancy falls through to the guarded window path instead.
let revealDispatchInFlight = false;

/**
 * Reveal a real OS window destination — or the shell-level singleton behind
 * a retired built-in path. Prefers the command-registered launcher route so
 * canvas pan and retired-path guards stay the single dispatch path; falls
 * back to the window manager when the palette entry has not been registered
 * yet (e.g. before the Desktop effect has run).
 */
export function revealShellAppWindow(path: string, title: string): void {
  const command = useCommandStore.getState().commands.get(`app:${path}`);
  if (command && !revealDispatchInFlight) {
    revealDispatchInFlight = true;
    try {
      const invoker = typeof document !== "undefined" && document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
      command.execute({ invoker });
    } finally {
      revealDispatchInFlight = false;
    }
    return;
  }
  // The raw window manager has no retired-path guard of its own (the
  // Desktop's openWindow wrapper carries it). "__aoede__"/"__workspace__"
  // must never become a window even when no launcher command is mounted.
  if (isRetiredBuiltInAppPath(path)) return;
  const wm = useWindowManager.getState();
  const existing = findWindowByPath(path);
  if (existing) {
    wm.restoreAndFocusWindow(existing.id);
  } else {
    wm.openWindow(title, path, shellDockXOffset());
  }
  panCanvasToWindow(path);
}

const SAFE_CHAT_ID = /^chat_[A-Za-z0-9_-]{1,80}$/;

/**
 * "View history" opens exactly the backing canonical conversation: select it
 * in the shared Chat state, then reveal/focus the real Chat window. It never
 * retargets Aoede itself and never opens a different chat.
 */
export function openAoedeHistory(
  chatId: string,
  switchConversation: (id: string) => void,
): void {
  if (!SAFE_CHAT_ID.test(chatId)) return;
  switchConversation(chatId);
  revealShellAppWindow("__chat__", "Chat");
}

/**
 * Canonical results open in the Preview window. The path was already screened
 * by the shared safe-path helper inside the controller projection; re-check
 * before touching the file surface (defense in depth).
 */
export function openAoedeResult(path: string): void {
  const safe = safeAoedeArtifactPath(path);
  if (!safe) return;
  usePreviewWindow.getState().openFile(safe);
  revealShellAppWindow("__preview-window__", "Preview");
}

// Mirrors the controller-side contract validation (defense in depth): slugs
// are bounded safe ids and paths stay inside `apps/<slug>` with no traversal,
// scheme/query noise or control bytes.
const SAFE_NAV_APP = /^[a-z0-9][a-z0-9_-]{0,79}$/;
const NAV_PATH_MAX = 160;
const NAV_PATH_FORBIDDEN = /[\\%?#:\x00-\x1f]/;

function registeredNavigationPath(prefix: string, requestedPath: string): string | null {
  const commands = useCommandStore.getState().commands;
  const candidates = requestedPath === prefix
    ? [`${prefix}/index.html`, `${prefix}/dist/index.html`]
    : [requestedPath];
  for (const candidate of candidates) {
    const normalized = normalizeBuiltInAppPath(candidate);
    if (!isRetiredBuiltInAppPath(normalized) && commands.has(`app:${normalized}`)) {
      return normalized;
    }
  }
  return null;
}

/**
 * Canonical "open this app result" navigation. Only destinations the shell can
 * actually reveal make it to the window manager: the path must normalize to a
 * registered app-launcher command (proof of installation), retired built-ins
 * never become windows, and `revealShellAppWindow` stays the single dispatch
 * path so no recursive command invocation or canvas-pan fork can sneak in.
 */
export function openAoedeNavigation(nav: { kind?: "open_app" | "close_app"; app: string; path: string }): void {
  if (!nav || typeof nav.app !== "string" || typeof nav.path !== "string") return;
  if (!SAFE_NAV_APP.test(nav.app) || nav.path.length === 0 || nav.path.length > NAV_PATH_MAX) return;
  if (nav.path.includes("..") || nav.path.includes("//") || NAV_PATH_FORBIDDEN.test(nav.path)) return;
  const prefix = `apps/${nav.app}`;
  if (nav.path !== prefix && nav.path !== `${prefix}.html`
    && nav.path !== `${prefix}/index.html` && nav.path !== `${prefix}/dist/index.html`) return;
  if (nav.kind === "close_app") {
    const window = useWindowManager.getState().windows.find(candidate =>
      candidate.path === prefix || candidate.path === `${prefix}.html`
      || candidate.path === `${prefix}/index.html` || candidate.path === `${prefix}/dist/index.html`);
    if (window) useWindowManager.getState().closeWindow(window.id);
    return;
  }
  const registeredPath = registeredNavigationPath(prefix, nav.path);
  if (!registeredPath) return;
  // A registered launcher proves the destination is installed and keeps the
  // reveal on the single dispatch path (canvas pan + retired-path guards).
  revealShellAppWindow(registeredPath, nav.app);
}
