import { useEffect } from "react";
import { useConnection } from "../../stores/connection";
import { useBoard } from "../../stores/board";
import { useUi } from "../../stores/ui";
import { useWorkspace } from "../../stores/workspace";
import Sidebar from "./Sidebar";
import Titlebar from "./Titlebar";
import Board from "../board/Board";
import TaskWorkspace from "../workspace/TaskWorkspace";
import ThreadView from "../threads/ThreadView";
import SessionsView from "../sessions/SessionsView";
import SettingsView from "../settings/SettingsView";
import StandaloneSession from "../sessions/StandaloneSession";
import QuickOpen from "../files/QuickOpen";
import Composer from "../threads/Composer";
import CommandPalette from "../palette/CommandPalette";
import { useGlobalShortcuts } from "./shortcuts";
import { invoke } from "../../lib/operator";
import { wireKernel } from "../../lib/kernel-wiring";

export default function MissionControl() {
  const api = useConnection((s) => s.api);
  const platformHost = useConnection((s) => s.platformHost);
  const runtimeSlot = useConnection((s) => s.runtimeSlot);
  const loadProjects = useBoard((s) => s.loadProjects);
  const view = useUi((s) => s.view);

  useGlobalShortcuts();

  useEffect(() => {
    // Wire workspace layout persistence through the trusted core once.
    const { configure, hydrate } = useWorkspace.getState();
    configure({
      loadLayouts: async () => {
        const result = await invoke("state:get", { key: "panelLayouts" });
        return (result.value as Record<string, never> | null) ?? null;
      },
      saveLayout: async (taskKey, layout) => {
        const current = await invoke("state:get", { key: "panelLayouts" });
        const layouts = (current.value as Record<string, unknown> | null) ?? {};
        await invoke("state:set", {
          key: "panelLayouts",
          value: { ...layouts, [taskKey]: layout },
        });
      },
    });
    void hydrate();
  }, []);

  useEffect(() => {
    if (!api) return;
    let cancelled = false;
    void (async () => {
      await loadProjects(api);
      if (cancelled) return;
      // Boot to the last-used project (FR-013/SC-001); fall back to the first.
      const { projects, activeProjectSlug, selectProject } = useBoard.getState();
      if (activeProjectSlug || projects.length === 0) return;
      let saved: unknown = null;
      try {
        saved = (await invoke("state:get", { key: "lastProjectSlug" })).value;
      } catch (err: unknown) {
        console.warn(
          "[mission-control] load last project failed:",
          err instanceof Error ? err.message : String(err),
        );
      }
      const target = projects.find((p) => p.slug === saved) ?? projects[0];
      if (target && !cancelled) {
        try {
          await selectProject(api, target.slug);
        } catch (err: unknown) {
          if (!cancelled) {
            console.warn(
              "[mission-control] restore last project failed:",
              err instanceof Error ? err.message : String(err),
            );
          }
        }
      }
    })().catch((err: unknown) => {
      console.warn(
        "[mission-control] initial project load failed:",
        err instanceof Error ? err.message : String(err),
      );
    });
    return () => {
      cancelled = true;
    };
  }, [api, loadProjects]);

  useEffect(() => {
    if (!api) return;
    const dispose = wireKernel();
    return dispose;
  }, [api, platformHost, runtimeSlot]);

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <Titlebar />
      <div className="flex min-h-0 flex-1">
        <Sidebar />
        <main
          className="flex min-w-0 flex-1 flex-col border-l"
          style={{ borderColor: "var(--border-subtle)", background: "var(--bg-app)" }}
        >
          {view.kind === "board" ? <Board /> : null}
          {view.kind === "task" ? <TaskWorkspace key={view.taskId} taskId={view.taskId} /> : null}
          {view.kind === "thread" ? <ThreadView key={view.threadId} threadId={view.threadId} /> : null}
          {view.kind === "sessions" ? <SessionsView /> : null}
          {view.kind === "session" ? (
            <StandaloneSession key={view.sessionName} sessionName={view.sessionName} />
          ) : null}
          {view.kind === "settings" ? <SettingsView /> : null}
        </main>
      </div>
      <Composer />
      <CommandPalette />
      <QuickOpen />
    </div>
  );
}
