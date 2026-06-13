import { EmbedHost } from "../embeds";

// Home is just the user's live hosted Matrix OS shell, full-bleed. Navigation
// (Chat, Board, Apps, Terminal) lives in the sidebar — no extra chrome here.
export default function HomeTab({ active = true }: { active?: boolean }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <EmbedHost kind="hosted-shell" active={active} />
    </div>
  );
}
