import { Image } from "expo-image";
import { StyleSheet, View } from "react-native";

export type MobileTerminalAgent = "claude" | "codex";

const AGENT_COLORS: Record<MobileTerminalAgent, string> = {
  claude: "#D8792C",
  codex: "#465243",
};

const AGENT_LOGOS = {
  claude: require("../../../../shell/public/agent-logos/claude-code.png"),
  codex: require("../../../../shell/public/agent-logos/codex.png"),
} as const;

export function TerminalAgentLogo({ agent }: { agent: MobileTerminalAgent }) {
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      pointerEvents="none"
      testID={`terminal-session-agent-logo-${agent}`}
      style={[styles.container, { backgroundColor: AGENT_COLORS[agent] }]}
    >
      <Image
        source={AGENT_LOGOS[agent]}
        contentFit="contain"
        testID={`terminal-session-agent-logo-image-${agent}`}
        style={styles.image}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    width: 16,
    height: 16,
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 4,
    overflow: "hidden",
  },
  image: {
    width: 11,
    height: 11,
  },
});
