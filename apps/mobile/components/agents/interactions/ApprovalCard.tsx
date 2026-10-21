import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";

import { Button } from "@/components/ui";

import { InteractionCard } from "./InteractionCard";

export type ApprovalDecision = "approve" | "deny";

export interface ApprovalCardProps {
  /** What the agent wants to do, as "<action> · <target>". */
  title: string;
  /** What exactly would be sent or changed. */
  preview?: string;
  /** The answer on its way to the server, while one is. */
  sending?: ApprovalDecision | null;
  error?: string | null;
  onAllow: () => void;
  onDeny: () => void;
  testID?: string;
}

/** An action that waits for the person: allow it this once, or deny it. */
export function ApprovalCard({ title, preview, sending = null, error, onAllow, onDeny, testID }: ApprovalCardProps) {
  return (
    <InteractionCard testID={testID} label="Needs your approval" title={title} error={error}>
      {preview?.trim() ? (
        <View testID={testID ? `${testID}-preview` : undefined} style={styles.preview}>
          <Text style={styles.previewText}>{preview}</Text>
        </View>
      ) : null}
      <Button
        size="large"
        fullWidth
        label="Allow once"
        loading={sending === "approve"}
        disabled={sending === "deny"}
        onPress={onAllow}
      />
      <Button
        variant="outline"
        fullWidth
        label="Deny"
        loading={sending === "deny"}
        disabled={sending === "approve"}
        onPress={onDeny}
      />
    </InteractionCard>
  );
}

const styles = StyleSheet.create((theme) => ({
  preview: {
    borderRadius: theme.v2.radius.control,
    paddingHorizontal: theme.v2.space[12],
    paddingVertical: theme.v2.space[10],
    backgroundColor: theme.v2.colors.card,
  },
  previewText: {
    ...theme.v2.text.caption,
    color: theme.v2.colors.textDefault,
  },
}));
