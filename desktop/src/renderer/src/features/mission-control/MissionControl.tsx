import { useEffect } from "react";
import { useConnection } from "../../stores/connection";
import { useBoard } from "../../stores/board";
import { useCodingAgentWorkspace } from "../../stores/coding-agent-workspace";
import { useTabs } from "../../stores/tabs";
import { useUi } from "../../stores/ui";
import { useWorkspace, type PanelLayout } from "../../stores/workspace";
import { CODING_AGENTS_DESKTOP_WORKSPACE } from "../../lib/feature-flags";
import Sidebar from "./Sidebar";
import TabBar from "./TabBar";
import TabContent from "./TabContent";
import Composer from "../threads/Composer";
import CommandPalette from "../palette/CommandPalette";
import CreateProjectDialog from "../board/CreateProjectDialog";
import QuickOpen from "../files/QuickOpen";
import { useGlobalShortcuts } from "./shortcuts";
import { invoke } from "../../lib/operator";
import { wireKernel } from "../../lib/kernel-wiring";

export default function MissionControl() {
  const api = useConnection((s) => s.api);
  const platformHost = useConnection((s) => s.platformHost);
  const runtimeSlot = useConnection((s) => s.runtimeSlot);
  const loadProjects = useBoard((s) => s.loadProjects);
  const openTab = useTabs((s) => s.openTab);
  const tabCount = useTabs((s) => s.tabs.length);
  const createProjectOpen = useUi((s) => s.createProjectOpen);
  const setCreateProjectOpen = useUi((s) => s.setCreateProjectOpen);

  useGlobalShortcuts();

  useEffect(() => {
    const { configure, hydrate } = useWorkspace.getState();
    configure({
      loadLayouts: async () => {
        const result = await invoke("state:get", { key: "panelLayouts" });
        return (result.value as Record<string, PanelLayout> | null) ?? null;
      },
      saveLayout: async (taskKey, layout) => {
        await invoke("state:set-panel-layout", { taskKey, layout });
      },
    });
    void hydrate();
  }, []);

  useEffect(() => {
    // Open the Home tab on first mount so the workspace is never empty.
    if (tabCount === 0) openTab({ kind: "home", title: "Home", closable: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
  }, [api, loadProjects, runtimeSlot]);

  useEffect(() => {
    if (!api) return;
    const dispose = wireKernel();
    return dispose;
  }, [api, platformHost, runtimeSlot]);

  // Eagerly load the coding-agent runtime summary: the Agents page used to own
  // this fetch, and now the sidebar attention badges, project headers, and the
  // command palette all read it. Runtime switches clear the store centrally
  // (reconcileDesktopRuntimeChange), so this just (re)loads for the scope.
  useEffect(() => {
    if (!api || !CODING_AGENTS_DESKTOP_WORKSPACE) return;
    const workspace = useCodingAgentWorkspace.getState();
    void workspace.refresh().then(() => {
      const current = useCodingAgentWorkspace.getState();
      if (current.notificationPreferencesStatus === "idle") {
        void current.loadNotificationPreferences();
      }
    });
  }, [api, runtimeSlot]);

  return (
    <div className="flex flex-1 overflow-hidden">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col" style={{ background: "var(--bg-app)" }}>
        <TabBar />
        <TabContent />
      </div>
      <Composer />
      <CommandPalette />
      <QuickOpen />
      <CreateProjectDialog open={createProjectOpen} onClose={() => setCreateProjectOpen(false)} />
    </div>
  );
}
