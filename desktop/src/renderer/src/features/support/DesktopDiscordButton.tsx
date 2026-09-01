import { DiscordIcon } from "../../lib/hugeicons";
import { invoke } from "../../lib/operator";

const DISCORD_INVITE_URL = "https://discord.gg/WHbvTG33w";

export default function DesktopDiscordButton() {
  return (
    <button
      type="button"
      aria-label="Join Discord"
      title="Join Discord"
      className="flex size-7 shrink-0 items-center justify-center rounded-md outline-none transition-colors hover:bg-[var(--bg-hover)] focus-visible:bg-[var(--bg-hover)]"
      style={{ color: "var(--text-secondary)" }}
      onClick={() => {
        void invoke("shell:open-external", { url: DISCORD_INVITE_URL }).catch((error: unknown) => {
          console.warn(
            "[desktop-discord] Failed to open invite:",
            error instanceof Error ? error.name : typeof error,
          );
        });
      }}
    >
      <DiscordIcon aria-hidden="true" size={16} />
    </button>
  );
}
