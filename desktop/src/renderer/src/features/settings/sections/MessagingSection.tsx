import { SlackInstallPanel, WhatsAppSettingsPanel } from "@matrix-os/ui";
import { WHATSAPP_SETTINGS_PATH } from "@matrix-os/contracts";
import { SLACK_INSTALL_URL } from "@matrix-os/contracts/slack-bridge";
import { useConnection } from "../../../stores/connection";
import { invoke } from "../../../lib/operator";
export default function MessagingSection() {
  const api = useConnection((s) => s.api);
  const userId = useConnection((s) => s.userId);
  const generation = useConnection((s) => s.authGeneration);
  const scope = JSON.stringify([userId, generation]);
  const open = async (url: string) => {
    await invoke("shell:open-external", { url });
  };
  return (
    <>
      <h2 className="text-xl font-semibold">Messaging</h2>
      <p className="mb-6 mt-2 text-sm text-muted-foreground">
        Your own Matrix, in the apps you already use.
      </p>
      <WhatsAppSettingsPanel
        key={String(Boolean(api))}
        scope={scope}
        load={async () => {
          if (!api) throw new Error("Connection unavailable");
          return api.get(WHATSAPP_SETTINGS_PATH, { maxBytes: 4096 });
        }}
        onOpen={open}
      />
      <SlackInstallPanel
        showHeading={false}
        onInstall={() => open(SLACK_INSTALL_URL)}
      />
    </>
  );
}
