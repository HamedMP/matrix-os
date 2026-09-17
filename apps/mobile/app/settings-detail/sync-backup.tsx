import { SettingsCardStack, SettingsPage, SettingsRow } from "@/components/settings/SettingsSurface";
import { Spacer, Text } from "@/components/ui";
import { useSettingsSyncBackup } from "@/lib/queries/use-settings-sync-backup";

function formatTime(value: number | null | undefined): string {
  if (!value) return "Not yet";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(value);
}

function freshnessLabel(value: string | undefined, pending: boolean): string {
  if (pending) return "Loading…";
  if (!value) return "Unavailable";
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}

export default function SyncBackupSettingsScreen() {
  const { backup, syncStatus, isPending, isError } = useSettingsSyncBackup();

  return (
    <SettingsPage>
      <SettingsCardStack>
        <SettingsRow
          card
          title="Folder sync"
          detail="Requires Matrix Desktop"
        />
        <SettingsRow
          card
          title="Database backup"
          detail={freshnessLabel(backup?.freshness, isPending)}
        />
        <SettingsRow
          card
          title="Matrix files"
          detail={isPending
            ? "Loading…"
            : syncStatus
              ? `${syncStatus.fileCount.toLocaleString()} files · ${syncStatus.pendingConflicts.toLocaleString()} conflicts`
              : "Unavailable"}
        />
        <SettingsRow
          card
          title="Last Matrix sync"
          detail={isPending ? "Loading…" : formatTime(syncStatus?.lastSyncAt)}
        />
        <SettingsRow
          card
          title="Latest verified backup"
          detail={isPending ? "Loading…" : formatTime(backup?.lastSuccess?.completedAt)}
        />
        <SettingsRow
          card
          title="Next scheduled run"
          detail={isPending ? "Loading…" : formatTime(backup?.scheduler.nextDueAt)}
        />
        <SettingsRow
          card
          title="Last restore test"
          detail={isPending ? "Loading…" : formatTime(backup?.lastSuccess?.restoreVerifiedAt)}
        />
        <SettingsRow
          card
          title="Scheduler"
          detail={isPending ? "Loading…" : backup?.scheduler.active === true
            ? "Active"
            : backup?.scheduler.active === false ? "Inactive" : "Unknown"}
        />
      </SettingsCardStack>
      <Spacer size="md" />
      <Text size="muted" tone="subtle">
        Database recovery copies are separate from file sync.
      </Text>
      <Spacer size="sm" />
      <Text size="muted" tone="subtle">
        Use Matrix Desktop to select and sync folders on a computer. Mobile monitors remote recovery health only.
      </Text>
      {isError ? (
        <>
          <Spacer size="sm" />
          <Text size="muted" tone="subtle">Backup health could not be loaded. Try again later.</Text>
        </>
      ) : null}
    </SettingsPage>
  );
}
