import { useMemo, type ReactNode } from "react";
import { AoedeProvider, AoedeAssistant } from "@matrix-os/ui/aoede";
import "@matrix-os/ui/aoede.css";
import { useConnection } from "../../stores/connection";
import { useTabs } from "../../stores/tabs";
import { createDesktopAoedeFetcher } from "../../lib/aoede-desktop";
import { openFileInDesktopEditor } from "../editor/desktop-editor-store";
import { parseApps } from "../apps/apps.api";
import { toast } from "sonner";

/** Electron supplies runtime-bound networking and navigation only. The same
 * owner/controller, media, captions and canonical cards drive every surface.
 */
export default function DesktopAoedeHost({ children }: { children: ReactNode }) {
  const identity = useConnection(s => JSON.stringify([s.userId, s.platformHost, s.runtimeSlot, s.authGeneration]));
  return <IdentityOwner key={identity}>{children}</IdentityOwner>;
}
function IdentityOwner({ children }: { children: ReactNode }) {
  const connection = useConnection.getState();
  const { platformHost, runtimeSlot, userId, authGeneration } = connection;
  const api = connection.api?.forRuntime(runtimeSlot);
  const fetcher = useMemo(() => createDesktopAoedeFetcher({ baseUrl: platformHost, runtimeSlot }), [platformHost, runtimeSlot]);
  const isCurrent = () => {
    const current = useConnection.getState();
    return current.status === "signed-in" && current.userId === userId && current.platformHost === platformHost
      && current.runtimeSlot === runtimeSlot && current.authGeneration === authGeneration;
  };
  const openApp = async ({ app }: { app: string }) => {
    try {
      if (!api || !isCurrent()) return;
      const apps = parseApps(await api.get<unknown>("/api/apps"));
      if (!isCurrent()) return;
      const installed = apps.find(item => item.slug === app);
      if (!installed) { toast.error("This app is unavailable. Open Chat to review the result."); return; }
      useTabs.getState().openTab({ kind: "app", slug: installed.slug, title: installed.name, ...(installed.appIdentity ? { appIdentity: installed.appIdentity } : {}) });
    } catch (error: unknown) {
      console.warn("[aoede] app open unavailable", error instanceof Error ? error.name : "UnknownError");
      if (isCurrent()) toast.error("The app could not be opened. Please try again.");
    }
  };
  return <AoedeProvider identityKey={`aoede:${userId}:${runtimeSlot}:${authGeneration}`} baseUrl={platformHost} fetcher={fetcher} surface="electron_desktop"
    onOpenHistory={chatId => { if (isCurrent()) useTabs.getState().openTab({ kind: "chat", chatId, chatView: "conversation", title: "Chat", closable: false }); }}
    onOpenResult={path => { if (isCurrent()) openFileInDesktopEditor(path); }}
    onOpenNavigation={nav => {
      if (!isCurrent()) return;
      if (nav.kind === "close_app") {
        const tabs = useTabs.getState();
        for (const tab of tabs.tabs) {
          if (tab.kind === "app" && tab.slug === nav.app) tabs.closeTab(tab.id);
        }
        return;
      }
      void openApp(nav);
    }}>
    {children}<AoedeAssistant />
  </AoedeProvider>;
}
