import { UsersIcon } from "@renderer/lib/hugeicons";
import { useWorkSharedDiscovery } from "../use-work-shared-discovery";

/** Shared discovery stays an authenticated entry; accepting still belongs to the existing shared surface. */
export function SharedWithMeRailRow({ onOpen }: { onOpen: () => void }) {
  const discovery = useWorkSharedDiscovery(true);
  if (!discovery.available) return null;
  const pendingCount = discovery.items.filter(item => item.status === "invited").length;
  return <button type="button" aria-label="Shared with me"
    className="flex min-h-8 shrink-0 items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-sm font-medium outline-none hover:bg-[var(--bg-hover)] focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
    style={{color:"var(--text-secondary)"}}
    onClick={onOpen}>
    <UsersIcon size={15} aria-hidden className="shrink-0" />
    <span className="min-w-0 flex-1 truncate">Shared with me</span>
    {pendingCount > 0 ? <span aria-label={`${pendingCount} pending invitations`}
      className="min-w-5 rounded-full bg-[var(--accent)] px-1.5 py-0.5 text-center text-[10px] text-[var(--text-inverse)]">
      {pendingCount > 99 ? "99+" : pendingCount}
    </span> : null}
  </button>;
}
