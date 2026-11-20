import { useAuth } from "@clerk/clerk-expo";
import { useGateway } from "@/app/_layout";
import { NotificationsSettingsView } from "@/components/settings/NotificationsSettingsView";
import { useNotificationPreferences } from "@/lib/use-notification-preferences";

export default function NotificationsScreen() {
  const { client, gateway } = useGateway();
  const { userId } = useAuth();
  const ownerKey = `${userId ?? "signed-out"}:${gateway?.id ?? "none"}:${gateway?.url ?? ""}:${gateway?.runtimeSlot ?? ""}`;
  return <NotificationsSettingsView key={ownerKey} connected={client !== null}
    settings={useNotificationPreferences(client, ownerKey)} />;
}
