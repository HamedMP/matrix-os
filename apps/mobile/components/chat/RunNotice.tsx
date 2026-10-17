import { Text, View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";

import { AlertIcon, Button, Icon, RetryIcon } from "@/components/ui";

const ALERT_ICON_SIZE = 18;
const RETRY_FAILED = "Could not retry. Try again.";

export interface RunNoticeProps {
  /** Why the work failed: the computer's reviewed words, or fixed copy. */
  text: string;
  /** Runs the turn again. Offered only where its failure says that can help. */
  onRetry?: () => void;
  /** The retry is on its way. */
  retrying?: boolean;
  /** Something else runs in the chat, so the turn cannot be run again yet. */
  retryDisabled?: boolean;
  /** The last retry was refused or did not reach the computer. */
  retryFailed?: boolean;
}

/** Where a turn's work failed: what happened, why, and a way to run it again. */
export function RunNotice({ text, onRetry, retrying = false, retryDisabled = false, retryFailed = false }: RunNoticeProps) {
  const { theme } = useUnistyles();
  return (
    <View testID="run-notice" style={styles.card}>
      <Icon icon={AlertIcon} size={ALERT_ICON_SIZE} color={theme.v2.colors.danger} />
      <View style={styles.body}>
        <Text style={styles.title}>Agent work failed</Text>
        <Text style={styles.text}>{text}</Text>
        {onRetry ? (
          <View style={styles.actions}>
            <Button
              variant="outline"
              label="Retry"
              icon={RetryIcon}
              loading={retrying}
              disabled={retryDisabled}
              onPress={onRetry}
            />
          </View>
        ) : null}
        {onRetry && retryFailed ? (
          <Text accessibilityRole="alert" style={styles.retryFailed}>{RETRY_FAILED}</Text>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  card: {
    alignSelf: "stretch",
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.v2.space[10],
    borderWidth: theme.v2.borderWidth.hairline,
    borderColor: theme.v2.colors.danger,
    borderRadius: theme.v2.radius.field,
    paddingHorizontal: theme.v2.space[14],
    paddingVertical: theme.v2.space[12],
  },
  body: {
    flex: 1,
    gap: theme.v2.space[2],
  },
  title: {
    ...theme.v2.text.labelMedium,
    color: theme.v2.colors.textDefault,
  },
  text: {
    ...theme.v2.text.caption,
    color: theme.v2.colors.textSubtle,
  },
  actions: {
    flexDirection: "row",
    paddingTop: theme.v2.space[8],
  },
  retryFailed: {
    ...theme.v2.text.footnote,
    color: theme.v2.colors.danger,
    paddingTop: theme.v2.space[6],
  },
}));
