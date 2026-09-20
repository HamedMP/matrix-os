import { useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { CanonicalToolActivity } from "@matrix-os/contracts";

export function ChatToolActivity({ activity }: { activity: CanonicalToolActivity }) {
  const [expanded, setExpanded] = useState(false);
  const glyph = activity.state === "running" ? "…" : activity.state === "completed" ? "✓" : activity.state === "failed" ? "✕" : "–";
  return (
    <View>
      <Pressable accessibilityRole="button"
        accessibilityLabel={activity.preview ? `${activity.label}: ${activity.preview}` : activity.label}
        accessibilityState={{ expanded }} disabled={!activity.detail}
        onPress={() => setExpanded(!expanded)} style={styles.row}>
        <Text style={styles.glyph}>{glyph}</Text>
        <Text style={[styles.label, activity.state === "failed" && styles.failed]}>
          {activity.label}
          {activity.preview ? <Text style={styles.preview}>{" "}· {activity.preview}</Text> : null}
        </Text>
      </Pressable>
      {expanded && activity.detail ? (
        <ScrollView style={styles.detail} nestedScrollEnabled>
          <Text selectable style={styles.preview}>{activity.detail}</Text>
        </ScrollView>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  row: { flexDirection: "row", alignItems: "flex-start", gap: 6 },
  glyph: { fontFamily: theme.v2.fonts.medium, fontSize: 12, color: theme.v2.appColors.muted, lineHeight: 18 },
  label: { flexShrink: 1, fontFamily: theme.v2.fonts.body, fontStyle: "italic", fontSize: 13, color: theme.v2.appColors.muted },
  failed: { color: theme.v2.appColors.danger },
  preview: { fontFamily: theme.v2.fonts.mono, fontStyle: "normal", fontSize: 12, color: theme.v2.appColors.muted },
  detail: { maxHeight: 240, marginTop: 6, marginLeft: 18 },
}));
