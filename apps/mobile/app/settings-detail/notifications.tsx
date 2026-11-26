import { NotificationsSettingsView } from "@/components/settings/NotificationsSettingsView";
import { useNotificationPreferences } from "@/lib/use-notification-preferences";
import { useNotificationComputer } from "@/lib/use-notification-computer";

export default function NotificationsScreen() {
  const computer = useNotificationComputer();
  return <NotificationsSettingsView key={computer.key} computer={computer}
    settings={useNotificationPreferences(computer.client, computer.key)} />;
}
