import { useConnection } from "../../stores/connection";
import { useUi } from "../../stores/ui";
import EmbedHost from "../embeds/EmbedHost";

// Home is just the user's live hosted Matrix OS shell, full-bleed. Navigation
// (Chat, Board, Apps, Terminal) lives in the sidebar — no extra chrome here.
export default function HomeTab({ active = true }: { active?: boolean }) {
  const signedIn = useConnection((s) => s.status === "signed-in");
  const refreshRequest = useUi((state) => state.homeRefreshRequest);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {signedIn ? (
        <EmbedHost kind="hosted-shell" active={active} refreshRequest={refreshRequest} />
      ) : null}
    </div>
  );
}
