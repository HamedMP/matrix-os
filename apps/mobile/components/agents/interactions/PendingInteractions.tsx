import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { BotInteraction } from "@matrix-os/contracts";

import { PendingInteraction, type PendingInteractionProps } from "./PendingInteraction";

export interface PendingInteractionsProps extends Omit<PendingInteractionProps, "interaction"> {
  /** In the order the server lists them. */
  interactions: readonly BotInteraction[];
}

/** Everything an agent is waiting on the person for, one card under the other. */
export function PendingInteractions({ interactions, ...card }: PendingInteractionsProps) {
  return (
    <View testID="pending-interactions" style={styles.stack}>
      {interactions.map((interaction) => (
        <PendingInteraction key={interaction.interactionId} interaction={interaction} {...card} />
      ))}
    </View>
  );
}

// As far apart as one message is from the next.
const styles = StyleSheet.create((theme) => ({
  stack: {
    gap: theme.v2.space[14],
  },
}));
