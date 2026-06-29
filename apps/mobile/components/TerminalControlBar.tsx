import { useCallback, useMemo } from "react";
import { FlatList, type ListRenderItem, Pressable, StyleSheet, Text, View } from "react-native";
import { buildTerminalControlSequence, type TerminalControlKey } from "@/lib/terminal-state";
import {
  TERMINAL_ARROW_KEYS,
  TERMINAL_CONTROL_KEYS,
  TERMINAL_SPECIAL_KEYS,
  TERMINAL_SYMBOL_KEYS,
  sendTerminalClipboardPaste,
} from "@/lib/terminal-controls";
import { colors, fonts } from "@/lib/theme";

interface TerminalControlBarProps {
  onSend: (data: string) => void;
  onFontScale: (delta: number) => void;
  onClear: () => void;
}

const light = colors.light;

type BarItem =
  | { id: string; label: string; kind: "seq"; seq: TerminalControlKey; danger?: boolean }
  | { id: string; label: string; kind: "text"; value: string }
  | { id: string; label: string; kind: "font"; delta: number }
  | { id: string; label: string; kind: "paste" }
  | { id: string; label: string; kind: "clear" }
  | { id: string; kind: "divider" };

const keyExtractor = (item: BarItem) => item.id;

/**
 * Single compact accessory row (Termius-style) that floats just above the OS
 * keyboard. One horizontal strip keeps the terminal surface tall instead of a
 * multi-row pad eating half the screen.
 */
export function TerminalControlBar({ onSend, onFontScale, onClear }: TerminalControlBarProps) {
  const items = useMemo<BarItem[]>(() => {
    const list: BarItem[] = [];
    for (const k of TERMINAL_SPECIAL_KEYS) {
      if (k.key === "enter") continue;
      list.push({ id: k.key, label: k.label, kind: "seq", seq: k.key });
    }
    for (const k of TERMINAL_CONTROL_KEYS) {
      list.push({ id: k.key, label: k.label, kind: "seq", seq: k.key, danger: k.key === "ctrl-c" });
    }
    for (const k of TERMINAL_ARROW_KEYS) {
      list.push({ id: k.key, label: k.label, kind: "seq", seq: k.key });
    }
    list.push({ id: "div-sym", kind: "divider" });
    for (const s of TERMINAL_SYMBOL_KEYS) {
      list.push({ id: `sym-${s.value}`, label: s.label, kind: "text", value: s.value });
    }
    list.push({ id: "div", kind: "divider" });
    list.push({ id: "font-", label: "A−", kind: "font", delta: -0.05 });
    list.push({ id: "font+", label: "A+", kind: "font", delta: 0.05 });
    list.push({ id: "paste", label: "Paste", kind: "paste" });
    list.push({ id: "clear", label: "Clear", kind: "clear" });
    return list;
  }, []);

  const renderItem = useCallback<ListRenderItem<BarItem>>(
    ({ item }) => {
      if (item.kind === "divider") return <View style={styles.divider} />;
      let onPress: () => void;
      if (item.kind === "seq") onPress = () => onSend(buildTerminalControlSequence(item.seq));
      else if (item.kind === "text") onPress = () => onSend(item.value);
      else if (item.kind === "font") onPress = () => onFontScale(item.delta);
      else if (item.kind === "paste") onPress = () => sendTerminalClipboardPaste(onSend);
      else onPress = onClear;
      const danger = item.kind === "seq" && item.danger;
      return (
        <Pressable accessibilityRole="button" accessibilityLabel={item.label} onPress={onPress} style={styles.key}>
          <Text style={danger ? styles.keyLabelDanger : styles.keyLabel}>{item.label}</Text>
        </Pressable>
      );
    },
    [onSend, onFontScale, onClear],
  );

  return (
    <FlatList
      horizontal
      data={items}
      keyExtractor={keyExtractor}
      renderItem={renderItem}
      showsHorizontalScrollIndicator={false}
      keyboardShouldPersistTaps="always"
      style={styles.bar}
      contentContainerStyle={styles.content}
    />
  );
}

const styles = StyleSheet.create({
  bar: {
    flexGrow: 0,
    borderTopWidth: 1,
    borderTopColor: light.line,
    backgroundColor: light.paper,
  },
  content: {
    alignItems: "center",
    gap: 7,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  key: {
    minWidth: 42,
    height: 38,
    paddingHorizontal: 12,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 10,
    borderWidth: 1,
    borderColor: light.line,
    backgroundColor: light.field,
  },
  keyLabel: {
    fontFamily: fonts.monoBold,
    fontSize: 14,
    color: light.ink,
  },
  keyLabelDanger: {
    fontFamily: fonts.monoBold,
    fontSize: 14,
    color: light.glow,
  },
  divider: {
    width: 1,
    height: 24,
    marginHorizontal: 3,
    backgroundColor: light.line,
  },
});
