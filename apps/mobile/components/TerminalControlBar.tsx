import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { buildTerminalControlSequence } from "@/lib/terminal-state";
import { TERMINAL_CONTROL_KEYS, sendTerminalClipboardPaste } from "@/lib/terminal-controls";
import { colors, fonts } from "@/lib/theme";

interface TerminalControlBarProps {
  onSend: (data: string) => void;
  onFontScale: (delta: number) => void;
  onClear: () => void;
}

export function TerminalControlBar({ onSend, onFontScale, onClear }: TerminalControlBarProps) {
  return (
    <View style={styles.container}>
      <View style={styles.arrowRow}>
        <IconButton icon="remove" label="Smaller text" onPress={() => onFontScale(-0.05)} />
        <ArrowPad onSend={onSend} />
        <IconButton icon="add" label="Larger text" onPress={() => onFontScale(0.05)} />
      </View>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.keyRow}
        keyboardShouldPersistTaps="handled"
      >
        {/* react-doctor-disable-next-line react-doctor/rn-no-scrollview-mapped-list -- fixed, short control bar (8 buttons); FlatList virtualization would add overhead with no benefit */}
        {TERMINAL_CONTROL_KEYS.map((entry) => (
          <KeyButton
            key={entry.key}
            label={entry.label}
            onPress={() => onSend(buildTerminalControlSequence(entry.key))}
          />
        ))}
        <KeyButton label="Paste" onPress={() => sendTerminalClipboardPaste(onSend)} />
        <KeyButton label="Clear" onPress={onClear} />
      </ScrollView>
    </View>
  );
}

function ArrowPad({ onSend }: { onSend: (data: string) => void }) {
  return (
    <View style={styles.arrowPad}>
      <ArrowButton icon="chevron-up" label="Up" onPress={() => onSend(buildTerminalControlSequence("arrow-up"))} />
      <View style={styles.arrowPadBottom}>
        <ArrowButton icon="chevron-back" label="Left" onPress={() => onSend(buildTerminalControlSequence("arrow-left"))} />
        <ArrowButton icon="chevron-down" label="Down" onPress={() => onSend(buildTerminalControlSequence("arrow-down"))} />
        <ArrowButton icon="chevron-forward" label="Right" onPress={() => onSend(buildTerminalControlSequence("arrow-right"))} />
      </View>
    </View>
  );
}

function KeyButton({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} style={styles.keyButton}>
      <Text style={styles.keyText}>{label}</Text>
    </Pressable>
  );
}

function ArrowButton({ icon, label, onPress }: { icon: keyof typeof Ionicons.glyphMap; label: string; onPress: () => void }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} style={styles.arrowButton}>
      <Ionicons name={icon} size={16} color={colors.dark.foreground} />
    </Pressable>
  );
}

function IconButton({ icon, label, onPress }: { icon: keyof typeof Ionicons.glyphMap; label: string; onPress: () => void }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} style={styles.iconButton}>
      <Ionicons name={icon} size={16} color={colors.dark.foreground} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: 10,
    paddingTop: 10,
    paddingBottom: 8,
    borderTopWidth: 1,
    borderTopColor: "rgba(140, 199, 190, 0.16)",
    backgroundColor: "#0f120f",
  },
  arrowRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    paddingHorizontal: 14,
  },
  arrowPad: {
    alignItems: "center",
    gap: 4,
  },
  arrowPadBottom: {
    flexDirection: "row",
    gap: 4,
  },
  keyRow: {
    gap: 8,
    paddingHorizontal: 14,
    paddingBottom: 2,
  },
  keyButton: {
    minWidth: 62,
    height: 38,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "rgba(140, 199, 190, 0.18)",
    backgroundColor: "rgba(234, 236, 234, 0.08)",
  },
  keyText: {
    fontFamily: fonts.monoBold,
    color: colors.dark.foreground,
    fontSize: 12,
  },
  arrowButton: {
    width: 44,
    height: 34,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "rgba(140, 199, 190, 0.18)",
    backgroundColor: "rgba(234, 236, 234, 0.08)",
  },
  iconButton: {
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "rgba(140, 199, 190, 0.18)",
    backgroundColor: "rgba(234, 236, 234, 0.08)",
  },
});
