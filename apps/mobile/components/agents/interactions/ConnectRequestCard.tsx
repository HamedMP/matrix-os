import { Text } from "react-native";
import { StyleSheet } from "react-native-unistyles";

import { Button } from "@/components/ui";

import { InteractionCard, InteractionNote } from "./InteractionCard";

export type ConnectAction = "start" | "decline";

export interface ConnectRequestCardProps {
  /** "Connect a service", from the copy every surface shares. */
  label: string;
  /** The service the agent wants connected. */
  title: string;
  /** What connecting it lets the agent do, in the server's words. */
  benefit: string;
  access: readonly string[];
  /** The answer on its way to the server, while one is. */
  sending?: ConnectAction | null;
  error?: string | null;
  onConnect: () => void;
  onDecline: () => void;
  testID?: string;
}

/** An agent asking for a service to be connected. */
export function ConnectRequestCard({
  label,
  title,
  benefit,
  access,
  sending = null,
  error,
  onConnect,
  onDecline,
  testID,
}: ConnectRequestCardProps) {
  return (
    <InteractionCard testID={testID} label={label} title={title} error={error}>
      <Text style={styles.benefit}>{benefit}</Text>
      <InteractionNote>{`Requested access: ${access.join(", ")}`}</InteractionNote>
      <Button
        size="large"
        fullWidth
        label="Connect"
        loading={sending === "start"}
        disabled={sending === "decline"}
        onPress={onConnect}
      />
      <Button
        variant="outline"
        fullWidth
        label="Decline"
        loading={sending === "decline"}
        disabled={sending === "start"}
        onPress={onDecline}
      />
    </InteractionCard>
  );
}

export interface ConnectContinueCardProps {
  label: string;
  title: string;
  error?: string | null;
  onContinue: () => void;
  testID?: string;
}

/** The server has a page where the connection is finished: this opens it. */
export function ConnectContinueCard({ label, title, error, onContinue, testID }: ConnectContinueCardProps) {
  return (
    <InteractionCard testID={testID} label={label} title={title} error={error}>
      <Button size="large" fullWidth label="Continue connecting" onPress={onContinue} />
    </InteractionCard>
  );
}

const styles = StyleSheet.create((theme) => ({
  benefit: {
    ...theme.v2.text.label,
    color: theme.v2.colors.textDefault,
  },
}));
