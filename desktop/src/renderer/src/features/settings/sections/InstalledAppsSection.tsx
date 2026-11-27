import { toast } from "sonner";
import { Button, EmptyState } from "../../../design/primitives";
import { AppWindow } from "../../../lib/hugeicons";
import { invoke } from "../../../lib/operator";
import { useConnection } from "../../../stores/connection";
import { appIconUrl, useAppsQuery } from "../../apps/apps.api";
import { REVEAL_LABEL, installErrorCopy } from "../../installed-apps/installed-apps";
import { useInstallAppFlow } from "../../installed-apps/use-install-app-flow";
import { Card, Empty, SettingsSectionHeader } from "./section-kit";

function RowIcon({ url, name }: { url: string | null; name: string }) {
  return url
    ? <img src={url} alt="" className="size-8 shrink-0 object-contain" draggable={false} />
    : (
      <span aria-hidden="true" className="flex size-8 shrink-0 items-center justify-center rounded-lg text-sm font-semibold"
        style={{ background: "var(--accent-muted)", color: "var(--accent-text)" }}>
        {name.charAt(0).toUpperCase()}
      </span>
    );
}

/** Apps installed on this device as desktop apps (spec 2711). Device-local: installs are not synced. */
export default function InstalledAppsSection() {
  const flow = useInstallAppFlow();
  const { data: catalog } = useAppsQuery();
  const platformHost = useConnection((state) => state.platformHost);
  const runtimeSlot = useConnection((state) => state.runtimeSlot);
  const list = flow.list;

  const run = (channel: "installed-apps:open" | "installed-apps:show", installId: string) => {
    void invoke(channel, { installId }).then((result) => {
      if (!result.ok) toast.error(installErrorCopy("failed"));
    }, (error: unknown) => {
      console.warn("[installed-apps] action failed:", error instanceof Error ? error.name : "UnknownError");
      toast.error(installErrorCopy("failed"));
    });
  };

  const iconFor = (slug: string, slot: string) => {
    const app = slot === runtimeSlot ? catalog?.find((candidate) => candidate.slug === slug) : undefined;
    return app ? appIconUrl(platformHost, app, runtimeSlot) : null;
  };

  return (
    <div>
      <SettingsSectionHeader title="Installed apps" description="Matrix apps you installed on this computer. Each opens in its own window and always runs the app's latest version." />
      {!list ? <Empty text="Loading installed apps…" /> : !list.available ? (
        <Empty text="Installing apps isn’t available on this computer." />
      ) : list.apps.length === 0 ? (
        <EmptyState
          icon={<AppWindow size={26} />}
          headline="No installed apps"
          description="Right-click an app in the launcher, or open its window’s More menu, and choose Install as App…"
        />
      ) : (
        <Card>
          <ul aria-label="Installed apps" className="flex flex-col divide-y" style={{ borderColor: "var(--border-subtle)" }}>
            {list.apps.map((app) => (
              <li key={app.installId} className="flex items-center gap-3 py-2 first:pt-0 last:pb-0">
                <RowIcon url={iconFor(app.slug, app.runtimeSlot)} name={app.name} />
                <span className="min-w-0 flex-1 truncate text-sm" style={{ color: "var(--text-primary)" }}>{app.name}</span>
                <Button variant="ghost" onClick={() => run("installed-apps:open", app.installId)}>Open</Button>
                <Button variant="ghost" onClick={() => run("installed-apps:show", app.installId)}>{REVEAL_LABEL[list.platform]}</Button>
                <Button variant="danger" aria-label={`Uninstall ${app.name}`} onClick={() => flow.requestUninstall(app, iconFor(app.slug, app.runtimeSlot))}>
                  Uninstall…
                </Button>
              </li>
            ))}
          </ul>
        </Card>
      )}
      {flow.dialog}
    </div>
  );
}
