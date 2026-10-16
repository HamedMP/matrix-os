import { Text, View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";

import { Button, Icon, OfflineIcon, Skeleton } from "@/components/ui";

const OFFLINE_ICON_SIZE = 40;

/**
 * Stands in for an opened chat's messages while they load: the shapes of a
 * short exchange, resting on the composer where the newest messages will be.
 */
export function ChatMessagesSkeleton() {
  return (
    <View
      testID="chat-loading"
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel="Loading chat"
      style={styles.skeleton}
    >
      <Skeleton testID="chat-loading-row" style={[styles.bubble, styles.longBubble]} />
      <View testID="chat-loading-row" style={styles.reply}>
        <Skeleton style={[styles.line, styles.fullLine]} />
        <Skeleton style={[styles.line, styles.longLine]} />
        <Skeleton style={[styles.line, styles.shortLine]} />
      </View>
      <Skeleton testID="chat-loading-row" style={[styles.bubble, styles.shortBubble]} />
    </View>
  );
}

export interface ChatUnavailableProps {
  /** Reads the chat again. */
  onRetry?: () => void;
}

/** Says an opened chat could not be read, with a way to try again. */
export function ChatUnavailable({ onRetry }: ChatUnavailableProps) {
  const { theme } = useUnistyles();
  return (
    <View testID="chat-unavailable" style={styles.unavailable}>
      <Icon icon={OfflineIcon} size={OFFLINE_ICON_SIZE} color={theme.v2.colors.textTertiary} />
      <View style={styles.copy}>
        <Text accessibilityRole="alert" style={styles.title}>Chat unavailable</Text>
        <Text style={styles.detail}>Check your connection, then try again.</Text>
      </View>
      {onRetry ? <Button variant="outline" label="Try again" onPress={onRetry} /> : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  // The message list's own spacing, so the messages take the shapes' place.
  skeleton: {
    flex: 1,
    justifyContent: "flex-end",
    gap: theme.v2.space[14],
    paddingHorizontal: theme.v2.space[20],
    paddingVertical: theme.v2.space[20],
  },
  bubble: {
    alignSelf: "flex-end",
    height: theme.v2.text.callout.lineHeight + theme.v2.space[10] * 2,
    borderRadius: theme.v2.radius.bubble,
  },
  longBubble: {
    width: "58%",
  },
  shortBubble: {
    width: "36%",
  },
  reply: {
    gap: theme.v2.space[8],
  },
  line: {
    height: theme.v2.space[14],
    borderRadius: theme.v2.radius.full,
  },
  fullLine: {
    width: "92%",
  },
  longLine: {
    width: "78%",
  },
  shortLine: {
    width: "54%",
  },
  unavailable: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: theme.v2.space[16],
    paddingHorizontal: theme.v2.space[24],
  },
  copy: {
    alignItems: "center",
    gap: theme.v2.space[6],
  },
  title: {
    ...theme.v2.text.headline,
    color: theme.v2.colors.textDefault,
    textAlign: "center",
  },
  detail: {
    ...theme.v2.text.callout,
    color: theme.v2.colors.textSubtle,
    textAlign: "center",
  },
}));
