import { useEffect } from "react";
import { useConnection } from "../../stores/connection";
import { useBoard } from "../../stores/board";
import { useTabs } from "../../stores/tabs";
import { useUi } from "../../stores/ui";
import { useWorkspace } from "../../stores/workspace";
import Sidebar from "./Sidebar";
import TabBar from "./TabBar";
import TabContent from "./TabContent";
import Composer from "../threads/Composer";
import CommandPalette from "../palette/CommandPalette";
import QuickOpen from "../files/QuickOpen";
import { useGlobalShortcuts } from "./shortcuts";
import { invoke } from "../../lib/operator";
import { wireKernel } from "../../lib/kernel-wiring";

export default function MissionControl() {
  const api = useConnection((s) => s.api);
  const loadProjects = useBoard((s) => s.loadProjects);
  const openTab = useTabs((s) => s.openTab);
  const tabCount = useTabs((s) => s.tabs.length);

  useGlobalShortcuts();

  useEffect(() => {
    const { configure, hydrate } = useWorkspace.getState();
    configure({
      loadLayouts: async () => {
        const result = await invoke("state:get", { key: "panelLayouts" });
        return (result.value as Record<string, never> | null) ?? null;
      },
      saveLayout: async (taskKey, layout) => {
        const current = await invoke("state:get", { key: "panelLayouts" });
        const layouts = (current.value as Record<string, unknown> | null) ?? {};
        await invoke("state:set", { key: "panelLayouts", value: { ...layouts, [taskKey]: layout } });
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
    void loadProjects(api);
    const dispose = wireKernel();
    return dispose;
  }, [api, loadProjects]);

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
    </div>
  );
}
