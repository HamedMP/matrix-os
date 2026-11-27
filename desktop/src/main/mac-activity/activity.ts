import { WorktreeIdSchema } from "@matrix-os/contracts";
import { Menu, nativeImage, Tray, type BaseWindow, type MenuItemConstructorOptions } from "electron";
import { showMacActivityDialog } from "./dialog";
import {
  createMacActivityHistory, MacActivityScope, MacActivityKindSchema, MacActivityPhaseSchema, type MacActivityEntry,
} from "./history";

export type MacActivityPhase = MacActivityEntry["phase"];
export type MacActivityKind = MacActivityEntry["kind"];
export interface MacActivityHandle {
  update(phase: MacActivityPhase): void;
  finish(phase: MacActivityPhase): void;
}
export type BeginMacActivity = (kind: MacActivityKind, worktreeId: string) => MacActivityHandle | undefined;

interface Options {
  userData: string;
  getScope(): string | null;
  stop(): void | Promise<void>;
  window?(): BaseWindow | null;
}

interface Activity {
  kind: MacActivityKind;
  worktreeId: string;
  phase?: MacActivityPhase;
}

const MAX_ACTIVE = 4;
const MAX_SHOWN = 12;
const KIND_LABEL: Record<MacActivityKind, string> = {
  preview: "Electron preview",
  terminal: "Mac terminal check",
  "background-checks": "Background Mac checks",
};
const PHASE_LABEL: Record<MacActivityPhase, string> = {
  "awaiting-approval": "Waiting for approval",
  ready: "Ready",
  running: "Running",
  returning: "Returning results",
  returned: "Results returned",
  declined: "Declined",
  stopped: "Stopped",
  expired: "Expired",
  failed: "Failed",
  revoked: "Revoked",
};
const PHASE_PRIORITY: Record<MacActivityPhase, number> = {
  "awaiting-approval": 5, running: 4, returning: 3, returned: 2, failed: 2,
  ready: 1, declined: 0, stopped: 0, expired: 0, revoked: 0,
};
const FINAL_PHASES: readonly MacActivityPhase[] = ["returned", "declined", "stopped", "expired", "failed", "revoked"];
// A 16-point template glyph for the native menu bar. macOS supplies its tint.
const TRAY_GLYPH = "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAaklEQVR4nGNgGLYgHorJAvxA/B6KyQL1UM3/yXEFzHaQIfeBeD0xmkC27Ifi81ADQAblQ10hj0UdDMdjk4A5Wx5qQD6Sy87jUIsTrId6BRYu/MR4Cd17/xkQ4UIWgEUpybYju4LsRDUEAADQDSLnub5aqAAAAABJRU5ErkJggg==";

export function createMacActivity(options: Options) {
  const history = createMacActivityHistory(options.userData);
  const active = new Set<Activity>();
  let scope: string | null = null;
  let generation = 0;
  let tray: Tray | undefined;
  let historyDialog: AbortController | undefined;
  let stopping: object | undefined;
  let closed = false;
  let warnedTray = false;

  function clearTray() {
    const previous = tray;
    tray = undefined;
    try { previous?.destroy(); }
    catch (error: unknown) { warnTray(error); }
  }

  function warnTray(error: unknown) {
    if (!warnedTray) console.warn("[mac-activity] menu bar status unavailable", error instanceof Error ? "Error" : "NonError");
    warnedTray = true;
  }

  function log(scope: string, activity: Activity, phase: MacActivityPhase) {
    if (phase !== activity.phase) {
      activity.phase = phase;
      void history.append(scope, { kind: activity.kind, worktreeId: activity.worktreeId, phase });
    }
  }

  function reset(nextScope: string | null) {
    if (scope) {
      for (const activity of active) {
        if (activity.phase) log(scope, activity, "revoked");
      }
    }
    active.clear();
    historyDialog?.abort();
    historyDialog = undefined;
    stopping = undefined;
    scope = nextScope;
    generation++;
    clearTray();
  }

  function refresh() {
    const current = MacActivityScope.safeParse(options.getScope());
    const nextScope = !closed && current.success ? current.data : null;
    if (scope !== nextScope) reset(nextScope);
  }

  async function showHistory(expectedGeneration?: number): Promise<void> {
    refresh();
    const current = scope;
    if (!current || historyDialog || (expectedGeneration !== undefined && expectedGeneration !== generation)) return;
    const request = new AbortController();
    historyDialog = request;
    try {
      const events = await history.read(current);
      refresh();
      if (request.signal.aborted || scope !== current) return;
      const detail = events?.slice(-MAX_SHOWN).reverse().map(event =>
        `${new Date(event.at).toLocaleString()} · ${KIND_LABEL[event.kind]} · ${PHASE_LABEL[event.phase]}\nWorktree ${event.worktreeId}`,
      ).join("\n\n");
      await showMacActivityDialog(options.window?.() ?? null, {
        type: "info",
        title: "Matrix",
        message: "Recent Mac Activity",
        detail: detail || (events ? "No recent activity for this account and computer." : "Activity history is unavailable."),
        buttons: ["Done"],
        signal: request.signal,
      });
    } catch (error: unknown) {
      if (!request.signal.aborted) console.warn("[mac-activity] history dialog unavailable", error instanceof Error ? "Error" : "NonError");
    } finally {
      if (historyDialog === request) historyDialog = undefined;
    }
  }

  async function stopCurrent(expectedGeneration: number) {
    refresh();
    if (!scope || generation !== expectedGeneration || stopping || !active.size) return;
    const request = {};
    stopping = request;
    render();
    try {
      await options.stop();
    } catch (error: unknown) {
      console.warn("[mac-activity] stop failed", error instanceof Error ? "Error" : "NonError");
    } finally {
      if (stopping === request) {
        stopping = undefined;
        refresh();
        render();
      }
    }
  }

  function render() {
    const visible = [...active].flatMap(activity => activity.phase ? [{ ...activity, phase: activity.phase }] : []);
    visible.sort((a, b) => PHASE_PRIORITY[b.phase] - PHASE_PRIORITY[a.phase]);
    if (!scope || !visible.length) {
      clearTray();
      return;
    }
    try {
      if (!tray) {
        const image = nativeImage.createFromBuffer(Buffer.from(TRAY_GLYPH, "base64"));
        image.setTemplateImage(true);
        tray = new Tray(image);
      }
      const current = generation;
      const title = stopping ? "Stopping" : PHASE_LABEL[visible[0]!.phase];
      tray.setTitle(`Matrix · ${title}`);
      tray.setToolTip(`Matrix Mac activity · ${title}`);
      const controls: MenuItemConstructorOptions[] = visible.map(({ kind, phase }) => ({
        label: `${KIND_LABEL[kind]} · ${PHASE_LABEL[phase]}`, enabled: false,
      }));
      tray.setContextMenu(Menu.buildFromTemplate([
        ...controls,
        { type: "separator" },
        { label: "Stop Mac Activity", enabled: !stopping, click: () => { void stopCurrent(current); } },
        { label: "Recent Mac Activity", click: () => { void showHistory(current); } },
      ]));
      warnedTray = false;
    } catch (error: unknown) {
      warnTray(error);
      clearTray();
    }
  }

  const begin: BeginMacActivity = (kind, worktreeId) => {
    refresh();
    const current = scope;
    if (!current || closed || active.size >= MAX_ACTIVE || !MacActivityKindSchema.safeParse(kind).success
      || !WorktreeIdSchema.safeParse(worktreeId).success) return;
    const admittedScope = current;
    const activity: Activity = { kind, worktreeId };
    active.add(activity);
    function change(phase: MacActivityPhase, finish: boolean) {
      refresh();
      if (scope !== admittedScope || !active.has(activity) || !MacActivityPhaseSchema.safeParse(phase).success) return;
      log(admittedScope, activity, phase);
      if (finish) active.delete(activity);
      render();
    }
    return {
      update: phase => change(phase, false),
      finish: phase => { if (FINAL_PHASES.includes(phase)) change(phase, true); },
    };
  };

  return {
    begin,
    showHistory: () => showHistory(),
    refresh,
    flush: history.flush,
    async close() {
      if (!closed) {
        closed = true;
        reset(null);
      }
      await history.flush();
    },
  };
}
