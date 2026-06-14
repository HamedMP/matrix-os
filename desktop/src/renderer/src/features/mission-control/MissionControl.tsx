import { useEffect } from "react";
import { useConnection } from "../../stores/connection";
import { useBoard } from "../../stores/board";
import { useUi } from "../../stores/ui";
import Sidebar from "./Sidebar";
import Titlebar from "./Titlebar";
import Board from "../board/Board";
import TaskWorkspace from "../workspace/TaskWorkspace";
import ThreadView from "../threads/ThreadView";
import SessionsView from "../sessions/SessionsView";
import SettingsView from "../settings/SettingsView";
import StandaloneSession from "../sessions/StandaloneSession";
import Composer from "../threads/Composer";
import CommandPalette from "../palette/CommandPalette";
import { useGlobalShortcuts } from "./shortcuts";
import { wireKernel } from "../../lib/kernel-wiring";

export default function MissionControl() {
  const api = useConnection((s) => s.api);
  const platformHost = useConnection((s) => s.platformHost);
  const runtimeSlot = useConnection((s) => s.runtimeSlot);
  const loadProjects = useBoard((s) => s.loadProjects);
  const view = useUi((s) => s.view);

  useGlobalShortcuts();

  useEffect(() => {
    if (!api) return;
    void loadProjects(api);
    const dispose = wireKernel();
    return dispose;
  }, [api, loadProjects, platformHost, runtimeSlot]);

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
    </div>
  );
}
