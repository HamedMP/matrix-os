import { Text, View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { useRouter } from "expo-router";
import ComputerTerminal01Icon from "@hugeicons/core-free-icons/ComputerTerminal01Icon";
import FileTextIcon from "@hugeicons/core-free-icons/FileTextIcon";
import Folder01Icon from "@hugeicons/core-free-icons/Folder01Icon";

import { ListRow, SearchField } from "@/components/shell/Controls";
import { Page } from "@/components/shell/Page";

export default function SearchScreen() {
  const router = useRouter();
  const { theme } = useUnistyles();

  return (
    <Page title="Search" subtitle="Find anything across your Matrix computer">
      <SearchField placeholder="Files, sessions, apps, and chats" />
      <Text style={styles.sectionLabel}>SUGGESTED</Text>
      <View style={styles.list}>
        <ListRow title="matrix-os" detail="Folder · Projects" icon={Folder01Icon} onPress={() => router.push({ pathname: "/file-browser", params: { folder: "Projects" } } as never)} />
        <ListRow title="solar-vale" detail="Active terminal" icon={ComputerTerminal01Icon} accent={theme.v2.appColors.blueSoft} onPress={() => router.push({ pathname: "/terminal-session/[session]", params: { session: "solar-vale" } } as never)} />
        <ListRow title="Notes" detail="Installed app" icon={FileTextIcon} accent={theme.v2.appColors.warmSurface} onPress={() => router.push({ pathname: "/app-preview/[app]", params: { app: "Notes" } } as never)} />
      </View>
    </Page>
  );
}

const styles = StyleSheet.create((theme) => ({
  sectionLabel: {
    marginTop: 28,
    marginBottom: 10,
    fontFamily: theme.v2.fonts.semibold,
    fontSize: 11,
    letterSpacing: 1.1,
    color: theme.v2.appColors.muted,
  },
  list: {
    gap: 10,
  },
}));
