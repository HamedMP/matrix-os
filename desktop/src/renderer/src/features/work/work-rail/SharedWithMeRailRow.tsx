import { UsersIcon } from "@renderer/lib/hugeicons";
import { useTabs } from "../../../stores/tabs";
import { useWorkSharedDiscovery } from "../use-work-shared-discovery";

/** Shared discovery stays an authenticated entry; accepting still belongs to the existing shared surface. */
export function SharedWithMeRailRow() {
  const discovery = useWorkSharedDiscovery(true);
  if (!discovery.available) return null;
  const pendingCount = discovery.items.filter(item => item.status === "invited").length;
  return <button type="button" aria-label="Shared with me"
    className="mx-1 flex min-h-9 items-center gap-2 rounded-lg px-2 text-left text-sm outline-none hover:bg-[var(--bg-hover)] focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
    onClick={() => useTabs.getState().openTab({ kind: "shared", title: "Shared with me" })}>
    <UsersIcon size={16} aria-hidden />
    <span className="min-w-0 flex-1"><span className="block truncate">Shared with me</span>
      <span className="block text-[11px]" style={{ color: "var(--text-tertiary)" }}>{discovery.error ? "Shared items unavailable" : discovery.loading ? "Loading shared items…" : pendingCount > 0 ? "Invitation awaiting review" : "Shared chats and projects"}</span>
    </span>
    {pendingCount > 0 ? <span aria-label={`${pendingCount} pending invitations`}
      className="min-w-5 rounded-full bg-[var(--accent)] px-1.5 py-0.5 text-center text-[10px] text-[var(--text-inverse)]">
      {pendingCount > 99 ? "99+" : pendingCount}
    </span> : null}
  </button>;
}
