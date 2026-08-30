import { StyleSheet, View } from "react-native";
import { useRouter } from "expo-router";

import { GridTile, MockSearchField } from "@/components/mock-shell/MockControls";
import { MockPage } from "@/components/mock-shell/MockPage";

const apps = [
  { name: "Chess", icon: "game-controller-outline" as const },
  { name: "Notes", icon: "document-text-outline" as const },
  { name: "Tasks", icon: "checkmark-circle-outline" as const },
  { name: "Weather", icon: "partly-sunny-outline" as const },
  { name: "Whiteboard", icon: "brush-outline" as const },
  { name: "Calculator", icon: "calculator-outline" as const },
  { name: "Clock", icon: "time-outline" as const },
  { name: "Music", icon: "musical-notes-outline" as const },
  { name: "Gallery", icon: "images-outline" as const },
];

export default function AppsScreen() {
  const router = useRouter();

  return (
    <MockPage title="Apps" subtitle="Experiences installed on solar-vale">
      <MockSearchField placeholder="Search apps" />
      <View style={styles.grid}>
        {apps.map((app, index) => (
          <GridTile
            key={app.name}
            label={app.name}
            icon={app.icon}
            accent={index === 0}
            onPress={() => router.push({ pathname: "/app-preview/[app]", params: { app: app.name } } as never)}
          />
        ))}
      </View>
    </MockPage>
  );
}

const styles = StyleSheet.create({
  grid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
    marginTop: 24,
  },
});
