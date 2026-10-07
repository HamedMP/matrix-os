import { ActivityIndicator, Modal, Pressable, Text, View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { GMAIL_CONNECTION_METHOD_LABELS, type GmailConnectionMethod, type GmailConnectionOptions } from "@matrix-os/contracts/integration-marketplace";
import { Spacer } from "@/components/ui";

export interface GmailChoiceState { loading: boolean; error: boolean; options: GmailConnectionOptions | null }
export function GmailConnectionChoice({ choice, onChoose, onRetry, onCancel }: {
  choice: GmailChoiceState | null;
  onChoose: (method: GmailConnectionMethod) => void;
  onRetry: () => void;
  onCancel: () => void;
}) {
  const { theme } = useUnistyles();
  return <Modal transparent animationType="fade" visible={choice !== null} onRequestClose={onCancel}>
    <View style={styles.overlay}>
      <View style={styles.card} accessibilityViewIsModal>
        <Spacer size="xl" />
        <Text style={styles.title} accessibilityRole="header">Connect Gmail</Text>
        <Spacer size="sm" />
        <Text style={styles.body}>Choose how to connect this account. You can keep separate accounts for each method.</Text>
        <Spacer size="lg" />
        {choice?.loading ? <ActivityIndicator accessibilityLabel="Loading Gmail connection options" color={theme.v2.appColors.muted} /> : choice?.error ? <>
          <Text style={styles.body}>Could not load Gmail connection options. Try again.</Text>
          <Spacer size="sm" />
          <ChoiceButton label="Retry" accessibilityLabel="Retry Gmail connection options" onPress={onRetry} />
        </> : choice?.options?.methods.map(method => <View key={method}>
          <ChoiceButton label={GMAIL_CONNECTION_METHOD_LABELS[method]} onPress={() => onChoose(method)} />
          <Spacer size="sm" />
        </View>)}
        <Spacer size="sm" />
        <ChoiceButton label="Cancel" accessibilityLabel="Cancel Gmail connection" onPress={onCancel} />
        <Spacer size="xl" />
      </View>
    </View>
  </Modal>;
}
function ChoiceButton({ label, accessibilityLabel, onPress }: { label: string; accessibilityLabel?: string; onPress: () => void }) {
  return <Pressable accessibilityRole="button" accessibilityLabel={accessibilityLabel ?? label} onPress={onPress} style={styles.button}>
    <Spacer size="md" /><Text style={styles.buttonText}>{label}</Text><Spacer size="md" />
  </Pressable>;
}
const styles = StyleSheet.create(theme => ({
  overlay: { flex: 1, alignItems: "center", justifyContent: "center", paddingHorizontal: 24, backgroundColor: "rgba(13, 12, 12, 0.36)" },
  card: { width: "100%", maxWidth: 440, paddingHorizontal: 24, borderRadius: 20, backgroundColor: theme.v2.appColors.surface },
  title: { fontFamily: theme.v2.fonts.semibold, fontSize: 20, color: theme.v2.appColors.ink },
  body: { fontFamily: theme.v2.fonts.body, fontSize: 14, color: theme.v2.appColors.muted },
  button: { borderRadius: 16, alignItems: "center", borderWidth: 1, borderColor: theme.v2.appColors.line },
  buttonText: { fontFamily: theme.v2.fonts.semibold, fontSize: 14, color: theme.v2.appColors.ink },
}));
