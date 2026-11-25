import { constants } from "node:fs";
import { access, lstat, open, realpath, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { MessageBoxOptions } from "electron";
import type { AuthStatus } from "../auth/auth-service";
import type { MacActionPairing, MacActionPairingLease } from "../desktop-pairing/action";

const FULL_ACCESS_MS = 15 * 60_000;
const CHECKOUT_MANIFEST_LIMIT = 128 * 1024;
const ELECTRON_EXECUTABLE = "desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron";

interface VerificationSource {
  checkout: string;
  electronPath: string;
  identity: string;
}

async function packageName(root: string, relativePath: string) {
  const path = join(root, relativePath);
  if (await realpath(path) !== path) return null;
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > CHECKOUT_MANIFEST_LIMIT) return null;
    const content = Buffer.alloc(info.size + 1);
    const { bytesRead } = await file.read(content, 0, content.length, 0);
    if (bytesRead !== info.size) return null;
    const manifest: unknown = JSON.parse(content.subarray(0, bytesRead).toString("utf8"));
    return typeof manifest === "object" && manifest !== null && "name" in manifest ? manifest.name : null;
  } finally {
    await file.close();
  }
}

export async function resolveVerificationSource(path: string): Promise<VerificationSource | null> {
  if (!isAbsolute(path)) return null;
  try {
    const checkout = await realpath(path);
    const root = await stat(checkout);
    if (!root.isDirectory() || root.uid !== process.getuid?.() || (root.mode & 0o022) !== 0) return null;
    const marker = await lstat(join(checkout, ".git"));
    if (!(marker.isDirectory() || marker.isFile())
      || await packageName(checkout, "package.json") !== "matrix-os"
      || await packageName(checkout, "desktop/package.json") !== "desktop") return null;

    // pnpm may link the installed package to its content-addressed store. The
    // launcher comes from the selected checkout's dependency. Never use the
    // installed Matrix app itself, or execute package JS to resolve a path.
    const electronPath = await realpath(join(checkout, ELECTRON_EXECUTABLE));
    const executable = await stat(electronPath);
    if (!executable.isFile() || (executable.mode & 0o022) !== 0) return null;
    await access(electronPath, constants.X_OK);
    return { checkout, electronPath, identity: JSON.stringify([
      checkout, root.dev, root.ino, electronPath, executable.dev, executable.ino, executable.mtimeMs, executable.size,
    ]) };
  } catch (error: unknown) {
    console.warn("[mac-verification] source unavailable", error instanceof Error ? error.name : "Error");
    return null;
  }
}

interface SetupDependencies {
  getStatus(): AuthStatus;
  pickDirectory(): Promise<string | null>;
  resolveSource(checkout: string): Promise<VerificationSource | null>;
  prompt(options: MessageBoxOptions): Promise<number>;
  acquirePairing: MacActionPairing;
  stop(reason: "stopped" | "revoked"): void;
  now?(): number;
}

interface Setup {
  account: string;
  source: VerificationSource;
}

interface Grant {
  setup: Setup;
  pairing: MacActionPairingLease;
  controller: AbortController;
  expiresAt: number;
  timer: ReturnType<typeof setTimeout>;
}

export function createMacVerificationSetup(options: SetupDependencies) {
  const now = options.now ?? Date.now;
  let setup: Setup | undefined;
  let grant: Grant | undefined;
  let menuRequest: AbortController | undefined;

  function accountIdentity() {
    const status = options.getStatus();
    if (!status.signedIn || status.runtimeSlot !== "primary") return null;
    const origin = URL.parse(status.platformHost);
    if (!origin || origin.protocol !== "https:" || origin.href !== `${origin.origin}/`) return null;
    return JSON.stringify([origin.origin, status.userId, status.handle, status.runtimeSlot, status.authGeneration]);
  }

  function revoke(reason: "stopped" | "revoked", stopRunning: boolean) {
    const active = grant;
    if (!active) return;
    grant = undefined;
    clearTimeout(active.timer);
    active.controller.abort(reason);
    active.pairing.close();
    if (stopRunning) options.stop(reason);
  }

  function clearSetup() {
    // Clear the session selection before aborting sources that can call back.
    setup = undefined;
    menuRequest?.abort("revoked");
    revoke("revoked", false);
  }

  function currentSetup() {
    const account = accountIdentity();
    if (setup && setup.account !== account) clearSetup();
    return setup;
  }

  async function resolveActiveSource(signal: AbortSignal) {
    const active = currentSetup();
    if (!active || signal.aborted) return null;
    const source = await options.resolveSource(active.source.checkout);
    if (signal.aborted || currentSetup() !== active) return null;
    if (!source || source.identity !== active.source.identity) {
      clearSetup();
      options.stop("revoked");
      return null;
    }
    return source;
  }

  function currentGrant() {
    const active = currentSetup();
    const candidate = grant;
    if (candidate && (candidate.setup !== active || candidate.controller.signal.aborted || now() >= candidate.expiresAt)) {
      revoke("revoked", true);
      return undefined;
    }
    return candidate;
  }

  async function getFullAccessApproval(signal: AbortSignal) {
    const candidate = currentGrant();
    if (!candidate || signal.aborted) return null;

    const check = async (boundarySignal: AbortSignal, retryBadGateway?: () => boolean) => {
      if (boundarySignal.aborted || currentGrant() !== candidate) return false;
      if (!await resolveActiveSource(boundarySignal) || currentGrant() !== candidate || boundarySignal.aborted) return false;
      const retryWhileCurrent = retryBadGateway && (() => currentGrant() === candidate && !boundarySignal.aborted && retryBadGateway());
      const paired = await candidate.pairing.check(boundarySignal, retryWhileCurrent);
      if (boundarySignal.aborted || currentGrant() !== candidate) return false;
      if (!paired) {
        revoke("revoked", true);
        return false;
      }
      return true;
    };

    return await check(signal) ? { check } : null;
  }

  function promptForConsent(message: string, detail: string, button: string, signal: AbortSignal) {
    return options.prompt({
      type: "question", message, detail, buttons: ["Cancel", button],
      defaultId: 0, cancelId: 0, signal,
    });
  }

  async function configure(account: string, signal: AbortSignal) {
    const selected = await options.pickDirectory();
    if (!selected || signal.aborted || accountIdentity() !== account) return;
    const source = await options.resolveSource(selected);
    if (signal.aborted || accountIdentity() !== account) return;
    if (!source) {
      await options.prompt({
        type: "info", message: "This checkout cannot run Mac Verification.",
        detail: "Choose a trusted Matrix OS checkout with the pinned local Electron dependencies installed.",
        buttons: ["OK"], signal,
      });
      return;
    }
    const approved = await promptForConsent("Enable Mac Verification?",
      `Trust the Matrix OS checkout at ${source.checkout} for this app session. Mac Verification builds this checkout in a temporary worktree and can return a screenshot to the requesting Matrix Chat. Each preview initially asks for Mac approval.`,
      "Enable for This Session", signal);
    if (approved !== 1 || signal.aborted || accountIdentity() !== account) return;
    const verified = await options.resolveSource(source.checkout);
    if (signal.aborted || accountIdentity() !== account || verified?.identity !== source.identity) return;
    setup = { account, source };
    options.stop("revoked");
  }

  async function authorize(active: Setup, signal: AbortSignal) {
    const status = options.getStatus();
    if (!status.signedIn) return;
    const response = await promptForConsent("Allow Full Access for Mac Verification?",
      `For 15 minutes, eligible Chats on ${status.handle} can run the built-in Electron verification against ${active.source.checkout} without another popup. This applies only to Mac Verification. You can stop it from Mac Activity or turn it off here.`,
      "Allow for 15 Minutes", signal);
    if (response !== 1 || signal.aborted || currentSetup() !== active || !await resolveActiveSource(signal)) return;
    const controller = new AbortController();
    const pairing = await options.acquirePairing(controller, signal);
    if (!pairing || signal.aborted || controller.signal.aborted || currentSetup() !== active) {
      controller.abort("revoked");
      pairing?.close();
      if (!signal.aborted && currentSetup() === active && !pairing) {
        await options.prompt({
          type: "info", message: "Mac Full Access needs an active pairing.",
          detail: "Open Mac Pairing from the Matrix menu before retrying.", buttons: ["OK"], signal,
        });
      }
      return;
    }
    revoke("revoked", true);
    const newGrant: Grant = {
      setup: active, pairing, controller, expiresAt: now() + FULL_ACCESS_MS,
      timer: setTimeout(() => revoke("revoked", true), FULL_ACCESS_MS),
    };
    newGrant.timer.unref();
    grant = newGrant;
    controller.signal.addEventListener("abort", () => {
      if (grant === newGrant) revoke("revoked", true);
    }, { once: true });
  }

  async function open() {
    if (menuRequest) return;
    const controller = new AbortController();
    menuRequest = controller;
    const signal = controller.signal;
    try {
      const account = accountIdentity();
      if (!account) {
        await options.prompt({ type: "info", message: "Sign in to your primary Computer to set up Mac Verification.",
          buttons: ["OK"], signal });
        return;
      }
      const active = currentSetup();
      if (!active) {
        await configure(account, signal);
        return;
      }
      const fullAccess = Boolean(currentGrant());
      const response = await options.prompt({
        type: "info", message: "Mac Verification",
        detail: `Trusted checkout: ${active.source.checkout}\n\n${fullAccess ? "Mac Full Access is on temporarily." : "Each verification asks for approval on this Mac."}`,
        buttons: ["Done", "Disable Verification", fullAccess ? "Turn Off Full Access" : "Allow Full Access…"],
        defaultId: 0, cancelId: 0, signal,
      });
      if (signal.aborted || currentSetup() !== active) return;
      if (response === 1) {
        clearSetup();
        options.stop("stopped");
      } else if (response === 2) {
        if (fullAccess) revoke("stopped", true);
        else await authorize(active, signal);
      }
    } finally {
      if (menuRequest === controller) menuRequest = undefined;
    }
  }

  return {
    enabled: () => Boolean(currentSetup()),
    open,
    resolveActiveSource,
    getFullAccessApproval,
    revokeFullAccess(reason: "stopped" | "revoked") {
      menuRequest?.abort(reason);
      revoke(reason, false);
    },
    clearSetup,
  };
}
