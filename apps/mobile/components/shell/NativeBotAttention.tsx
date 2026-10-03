import { Pressable, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Spacer, Text } from "@/components/ui";
import type { NativeBotConversationSummary } from "@/lib/requests/bot-navigation";

export function NativeBotAttention({ bots, unavailable, onOpen }: {
  bots: NativeBotConversationSummary[];
  unavailable: boolean;
  onOpen: (chatId: string) => void;
}) {
  const pending = bots.filter(bot => bot.pendingApprovalCount > 0);
  if (!pending.length && !unavailable) return null;
  return <View style={styles.section}>
    <Spacer size="xl" />
    {pending.length > 0 ? <>
      <Text size="overline" tone="subtle">Needs you</Text>
      <Spacer size="sm" />
      {pending.map(bot => <Pressable key={bot.chatId}
        accessibilityRole="button"
        accessibilityLabel={`Review ${bot.name}, ${bot.pendingApprovalCount} pending ${bot.pendingApprovalCount === 1 ? "approval" : "approvals"}`}
        onPress={() => onOpen(bot.chatId)}
        style={({ pressed }) => [styles.row, pressed && styles.pressed]}>
        <Text size="body" numberOfLines={1}>{bot.name}</Text>
        <Text size="muted" tone="subtle">{bot.pendingApprovalCount} pending {bot.pendingApprovalCount === 1 ? "approval" : "approvals"}</Text>
      </Pressable>)}
    </> : null}
    {unavailable ? <Text size="muted" tone="subtle">Some chat statuses could not be loaded. Trying again…</Text> : null}
  </View>;
}

const styles = StyleSheet.create({
  section: { paddingHorizontal: 8 },
  row: { paddingVertical: 6, borderRadius: 10, gap: 4 },
  pressed: { opacity: 0.65 },
});
