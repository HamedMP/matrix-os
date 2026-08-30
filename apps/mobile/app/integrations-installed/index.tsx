import { StyleSheet, View } from "react-native";

import { ListRow } from "@/components/mock-shell/MockControls";
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
      <View style={styles.list}>
        {installed.map((item) => (
          <ListRow
            key={item.name}
            title={item.name}
            detail={item.detail}
            icon="checkmark-circle-outline"
            accent={item.color}
            actionIcon="checkmark-circle"
            onPress={() => {}}
          />
        ))}
      </View>
    </MockPage>
  );
}

const styles = StyleSheet.create({ list: { gap: 10 } });
