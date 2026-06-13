import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { colors, fonts, radius, spacing } from "@/lib/theme";
import {
  PROVISIONING_STAGE_LABEL,
  type JourneyFetchResult,
} from "@/lib/journey";

interface JourneyGateProps {
  /** null while the first fetch is in flight. */
  result: JourneyFetchResult | null;
  onRetry: () => void;
  onOpenUrl: (url: string) => void;
  working?: boolean;
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <View style={styles.container} testID="journey-gate">
      <View style={styles.card}>{children}</View>
    </View>
  );
}

function Title({ children }: { children: React.ReactNode }) {
  return <Text style={styles.title}>{children}</Text>;
}

function Body({ children }: { children: React.ReactNode }) {
  return <Text style={styles.body}>{children}</Text>;
}

function PrimaryButton({ label, onPress, testID }: { label: string; onPress: () => void; testID: string }) {
  return (
    <Pressable
      testID={testID}
      onPress={onPress}
      style={({ pressed }) => [styles.button, pressed && styles.buttonPressed]}
    >
      <Text style={styles.buttonLabel}>{label}</Text>
    </Pressable>
  );
}

/**
 * Renders the user's onboarding phase on mobile (spec 092). Phase-appropriate
 * screens for plan selection, payment settling, machine build, and retry —
 * `first_run`/`ready` are handled by the caller (it hands off to the shell).
 */
export function JourneyGate({ result, onRetry, onOpenUrl, working = false }: JourneyGateProps) {
  if (!result) {
    return (
      <Centered>
        <ActivityIndicator color={colors.light.primary} testID="journey-loading" />
        <Body>Loading your Matrix computer…</Body>
      </Centered>
    );
  }

  if (result.status === "unauthorized") {
    return (
      <Centered>
        <Title>Please sign in again</Title>
        <Body>Your session expired.</Body>
      </Centered>
    );
  }

  if (result.status === "unreachable") {
    return (
      <Centered>
        <Title>Can’t reach Matrix</Title>
        <Body>We couldn’t reach Matrix right now.</Body>
        <PrimaryButton label="Try again" onPress={onRetry} testID="journey-retry" />
      </Centered>
    );
  }

  const journey = result.journey;
  switch (journey.phase) {
    case "account_required":
      // The local Clerk session no longer resolves to a platform account; the
      // only way forward is to re-authenticate, not to wait on a spinner.
      return (
        <Centered>
          <Title>Please sign in again</Title>
          <Body>{journey.detail || "Your session needs to be refreshed to continue."}</Body>
        </Centered>
      );
    case "plan_required":
      return (
        <Centered>
          <Title>Choose your plan</Title>
          <Body>{journey.detail}</Body>
          {journey.nextAction.url ? (
            <PrimaryButton label="View plans" testID="journey-open-plans" onPress={() => onOpenUrl(journey.nextAction.url as string)} />
          ) : null}
        </Centered>
      );
    case "payment_settling":
      return (
        <Centered>
          {journey.settling?.delayed ? null : <ActivityIndicator color={colors.light.primary} testID="journey-loading" />}
          <Title>{journey.settling?.delayed ? "Taking longer than expected" : "Activating your subscription"}</Title>
          <Body>{journey.detail}</Body>
        </Centered>
      );
    case "provisioning":
      return (
        <Centered>
          <ActivityIndicator color={colors.light.primary} testID="journey-loading" />
          <Title>Building your Matrix computer</Title>
          <Body>{journey.progress ? (PROVISIONING_STAGE_LABEL[journey.progress.stage] ?? journey.detail) : journey.detail}</Body>
        </Centered>
      );
    case "provisioning_failed":
      return (
        <Centered>
          <Title>Setup needs attention</Title>
          <Body>{journey.detail}</Body>
          {journey.failure?.retryable ? (
            <PrimaryButton label={working ? "Retrying…" : "Retry setup"} testID="journey-retry" onPress={onRetry} />
          ) : null}
        </Centered>
      );
    default:
      // first_run / ready / account_required — the caller redirects.
      return (
        <Centered>
          <ActivityIndicator color={colors.light.primary} testID="journey-loading" />
          <Body>Opening your Matrix computer…</Body>
        </Centered>
      );
  }
}

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: colors.light.background, padding: spacing.lg },
  card: { alignItems: "center", gap: spacing.md, maxWidth: 360 },
  title: { fontFamily: fonts.sansSemiBold, fontSize: 20, color: colors.light.forest, textAlign: "center" },
  body: { fontFamily: fonts.sans, fontSize: 14, color: colors.light.forest, opacity: 0.8, textAlign: "center" },
  button: { backgroundColor: colors.light.primary, paddingVertical: spacing.sm, paddingHorizontal: spacing.lg, borderRadius: radius.md },
  buttonPressed: { opacity: 0.85 },
  buttonLabel: { fontFamily: fonts.sansSemiBold, fontSize: 15, color: colors.light.primaryForeground },
});
