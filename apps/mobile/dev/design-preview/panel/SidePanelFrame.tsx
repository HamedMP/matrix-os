import type { ReactNode } from "react";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";

import { SidePanel } from "@/components/shell/SidePanel";

import { C2_CHATS, C2_NOW, C2_PROJECT_COUNT } from "./sample";

function noop() {}

/** The side panel alone, at its own width, with the content of frame C2. */
export function SidePanelFrame() {
  return (
    <View testID="side-panel-frame" style={styles.panel}>
      <SidePanel
        chats={C2_CHATS}
        projectCount={C2_PROJECT_COUNT}
        now={C2_NOW}
        onSearchQueryChange={noop}
        onNewChat={noop}
        onSelectChat={noop}
        onOpenProjects={noop}
        onOpenShared={noop}
      />
    </View>
  );
}

/** Frame C2: the side panel open over a screen (`children`), with the scrim between them. */
export function SidePanelOverScreen({ children }: { children: ReactNode }) {
  return (
    <View style={styles.stage}>
      {children}
      <View testID="side-panel-frame-scrim" style={styles.scrim} />
      <View testID="side-panel-frame-raised" style={styles.raised}>
        <SidePanelFrame />
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  stage: {
    flex: 1,
  },
  panel: {
    flex: 1,
    width: theme.v2.size.sidePanel,
    backgroundColor: theme.v2.colors.background,
  },
  scrim: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: theme.v2.colors.scrim,
  },
  raised: {
    position: "absolute",
    top: 0,
    bottom: 0,
    left: 0,
    boxShadow: theme.v2.designShadows.panel,
  },
}));
