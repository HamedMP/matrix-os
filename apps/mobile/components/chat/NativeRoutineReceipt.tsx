import { useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { isRoutineDirectChatId, type RoutineChatReceiptPart } from "@matrix-os/contracts";
import { routineReceiptOutcome } from "@matrix-os/ui/routine-origin";
import { Button } from "@/components/ui";
import { NativeScheduledMessageMeta } from "@/components/agents/schedules/RoutineMessage";

export function NativeRoutineReceipt({ receipt, text, sourceChatId, onOpenChat }: {
  receipt: RoutineChatReceiptPart; text: string; sourceChatId?: string; onOpenChat?: (chatId: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const internalExecutor = isRoutineDirectChatId(receipt.canonicalChatId);
  return <View accessibilityLabel="Scheduled task result" style={styles.card}>
    <NativeScheduledMessageMeta timestamp={receipt.scheduledFor} sent={false}/>
    <Text style={styles.text}>{routineReceiptOutcome(receipt)}</Text>
    <Text selectable style={styles.text}>{text || "Output unavailable. Review this task in Schedules."}</Text>
    <Text style={styles.text}>{`Matrix routine · ${receipt.model}`}</Text>
    <Button variant="text" label={expanded ? "Hide execution details" : "Execution details"} onPress={() => setExpanded(value => !value)} />
    {expanded ? <Text style={styles.text}>{[
      `Source Chat: ${sourceChatId ?? "This Chat"}`,
      ...(!internalExecutor ? [`Executor Chat: ${receipt.canonicalChatId}`] : []),
      `Task: ${receipt.canonicalTaskId}`,
      `Routine: ${receipt.routineId}`,
      `Occurrence: ${receipt.fireId} · attempt ${receipt.attempt}`,
    ].join("\n")}</Text> : null}
    {onOpenChat && !internalExecutor ? <Button variant="text" label="Open execution history" onPress={() => onOpenChat(receipt.canonicalChatId)} /> : null}
  </View>;
}
const styles = StyleSheet.create(theme => ({
  card: { gap: 8, padding: 12, borderWidth: 1, borderRadius: 12, borderColor: theme.colors.border },
  text: { color: theme.colors.foreground },
}));
