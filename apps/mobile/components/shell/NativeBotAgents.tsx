import { useState } from "react";
import { Pressable, View } from "react-native";
import { LocalSvg } from "react-native-svg/css";
import { StyleSheet } from "react-native-unistyles";
import ArrowDown01Icon from "@hugeicons/core-free-icons/ArrowDown01Icon";
import ArrowRight01Icon from "@hugeicons/core-free-icons/ArrowRight01Icon";
import { Icon, Spacer, Text } from "@/components/ui";
import type { NativeBotConversationSummary } from "@/lib/requests/bot-navigation";

const rabbit = require("../../assets/app.icon/Assets/rabbit.svg");

/** Bound Bot histories remain reachable even without pending approvals. */
export function NativeBotAgents({ bots, activeChatId, onOpen }: {
  bots: NativeBotConversationSummary[];
  activeChatId: string | null;
  onOpen: (chatId: string) => void;
}) {
  const [expanded, setExpanded] = useState(true);
  if (!bots.length) return null;
  return <View style={styles.section}>
    <Spacer size="xl" />
    <Pressable accessibilityRole="button" accessibilityState={{ expanded }}
      accessibilityLabel={expanded ? "Collapse Agents" : "Expand Agents"}
      onPress={() => setExpanded(value => !value)} style={styles.heading}>
      <Text size="overline" tone="subtle">Agents</Text>
      <Icon icon={expanded ? ArrowDown01Icon : ArrowRight01Icon} size={16} />
    </Pressable>
    {expanded ? <>
      <Spacer size="sm" />
      {bots.map(bot => <Pressable key={bot.chatId}
        accessibilityRole="button" accessibilityLabel={`Open agent ${bot.name}`}
        accessibilityState={{ selected: activeChatId === bot.chatId }}
        onPress={() => onOpen(bot.chatId)}
        style={({ pressed }) => [styles.row, activeChatId === bot.chatId && styles.active, pressed && styles.pressed]}>
        <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={styles.avatar}>
          <LocalSvg asset={rabbit} width={20} height={24} />
        </View>
        <View style={styles.label}><Text size="body" numberOfLines={1}>{bot.name}</Text></View>
      </Pressable>)}
    </> : null}
  </View>;
}

const styles = StyleSheet.create(theme => ({
  section: { paddingHorizontal: 8 },
  heading: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  row: { flexDirection: "row", alignItems: "center", paddingVertical: 6, borderRadius: 10, gap: 12 },
  label: { flex: 1 },
  avatar: { width: 24, alignItems: "center" },
  active: { backgroundColor: theme.v2.appColors.soft },
  pressed: { opacity: 0.65 },
}));
