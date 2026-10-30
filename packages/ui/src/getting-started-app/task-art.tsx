import type { GettingStartedAppTask, GettingStartedAppTaskId } from "@matrix-os/contracts";
import { Gift, Smartphone, type LucideIcon } from "lucide-react";
import { useState } from "react";
import { codingAgentArtworkSrc, settingsHarnessArtworkSrc } from "../coding-agent-artwork.js";
import { RabbitAvatar } from "../onboarding-widget/parts.js";

/** Sculpted app icons (v2 family) for the Build tasks. */
const SCULPTED_ICONS: Partial<Record<GettingStartedAppTaskId, string>> = {
  "build-app": "/system-app-icons/v2/create-app.png",
  "build-memory": "/system-app-icons/v2/notes.png",
};

const LINE_ICONS: Partial<Record<GettingStartedAppTaskId, LucideIcon>> = {
  "mobile-app": Smartphone,
  "invite-friends": Gift,
};

/** A task's picture: the rabbit, the AI provider marks, a sculpted app icon, the integration's logo, or a line icon. */
export function TaskArt({ task, logo }: { task: GettingStartedAppTask; logo: string | undefined }) {
  // Remember which URL failed, so a new logo URL gets its own chance to load.
  const [failedLogo, setFailedLogo] = useState<string | null>(null);
  if (task.id === "create-agent") return <RabbitAvatar size={28} />;
  if (task.id === "ai-provider") {
    return (
      <span className="mxo-gsa__art-pair">
        <img src={settingsHarnessArtworkSrc("claude")} alt="" width={18} height={18} />
        <img src={settingsHarnessArtworkSrc("codex")} alt="" width={18} height={18} />
      </span>
    );
  }
  const sculpted = SCULPTED_ICONS[task.id];
  if (sculpted) return <img className="mxo-gsa__art-sculpted" src={codingAgentArtworkSrc(sculpted)} alt="" width={30} height={30} />;
  if (logo && logo !== failedLogo) {
    return <img className="mxo-gsa__art-logo" src={logo} alt="" width={22} height={22} referrerPolicy="no-referrer" onError={() => setFailedLogo(logo)} />;
  }
  const Icon = LINE_ICONS[task.id];
  return Icon ? <Icon size={20} strokeWidth={1.75} aria-hidden="true" /> : <span aria-hidden="true">{task.title.slice(0, 1)}</span>;
}
