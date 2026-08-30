import CheckmarkCircle02Icon from "@hugeicons/core-free-icons/CheckmarkCircle02Icon";

import { ListRow, ListRowStack } from "@/components/mock-shell/MockControls";
import { MockPage } from "@/components/mock-shell/MockPage";

const installed = [
  { name: "Slack", detail: "Matrix OS workspace · connected", color: "#E4C7FF" },
  { name: "GitHub", detail: "FinnaAI · connected", color: "#FFD0D0" },
  { name: "Google Drive", detail: "Personal · connected", color: "#FFE3B3" },
  { name: "Linear", detail: "Matrix OS · connected", color: "#BDDFFF" },
];

export default function InstalledIntegrationsScreen() {
  return (
    <MockPage title="Installed" subtitle="Services Matrix can currently access">
      <ListRowStack>
        {installed.map((item) => (
          <ListRow
            key={item.name}
            title={item.name}
            detail={item.detail}
            icon={CheckmarkCircle02Icon}
            accent={item.color}
            actionIcon={CheckmarkCircle02Icon}
            onPress={() => {}}
          />
        ))}
      </ListRowStack>
    </MockPage>
  );
}
