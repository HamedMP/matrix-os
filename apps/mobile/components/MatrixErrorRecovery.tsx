import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { colors, fonts, radius, spacing } from "@/lib/theme";

export function MatrixErrorRecovery({ title, details, onRetry, onRepair }: {
  title: string;
  details: string;
  onRetry: () => void;
  onRepair: () => Promise<unknown>;
}) {
  const [state, setState] = useState<"idle" | "sending" | "sent" | "failed">("idle");
  const [showDetails, setShowDetails] = useState(false);
  async function repair() {
    if (state === "sending") return;
    setState("sending");
    try {
      await onRepair();
      setState("sent");
    } catch (error) {
      console.warn("[mobile-error-recovery] repair failed", error instanceof Error ? error.name : "UnknownError");
      setState("failed");
    }
  }
  return <View style={{ flex: 1, justifyContent: "center", padding: spacing.xl, backgroundColor: colors.light.background }}>
    <Text style={{ fontFamily: fonts.sansSemiBold, fontSize: 20, color: colors.light.foreground }}>{title}</Text>
    <Text style={{ marginTop: spacing.sm, fontFamily: fonts.sans, fontSize: 14, lineHeight: 20, color: colors.light.mutedForeground }}>
      Matrix could not load this app. Try again or ask Matrix to investigate.
    </Text>
    <Pressable accessibilityRole="button" disabled={state === "sending"} onPress={() => void repair()}
      style={{ minHeight: 44, marginTop: spacing.lg, paddingHorizontal: spacing.md, justifyContent: "center", borderRadius: radius.card, backgroundColor: colors.light.foreground }}>
      <Text style={{ fontFamily: fonts.sansSemiBold, color: colors.light.background }}>{state === "sending" ? "Opening repair chat…" : "Fix with Matrix"}</Text>
    </Pressable>
    <Pressable accessibilityRole="button" onPress={onRetry} style={{ minHeight: 44, justifyContent: "center" }}>
      <Text style={{ fontFamily: fonts.sansSemiBold, color: colors.light.foreground }}>Try again</Text>
    </Pressable>
    <Pressable accessibilityRole="button" onPress={() => setShowDetails(value => !value)} style={{ minHeight: 44, justifyContent: "center" }}>
      <Text style={{ fontFamily: fonts.sans, color: colors.light.mutedForeground }}>Details</Text>
    </Pressable>
    {showDetails ? <Text selectable style={{ fontFamily: fonts.sans, fontSize: 12, color: colors.light.mutedForeground }}>{details}</Text> : null}
    {state === "failed" ? <Text accessibilityRole="alert" style={{ color: colors.light.foreground }}>Could not open a repair chat. Try again.</Text> : null}
    {state === "sent" ? <Text accessibilityRole="text" style={{ color: colors.light.foreground }}>Repair chat opened.</Text> : null}
  </View>;
}
