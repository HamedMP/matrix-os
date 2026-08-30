import { MockPage } from "@/components/mock-shell/MockPage";
import { Text } from "@/components/ui";

export default function SettingsScreen() {
  return (
    <MockPage title="Settings" subtitle="Configure Matrix OS on solar-vale">
      <Text size="body" tone="subtle">Settings will live here.</Text>
    </MockPage>
  );
}
