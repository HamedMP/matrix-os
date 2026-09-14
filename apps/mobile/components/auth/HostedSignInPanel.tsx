import { View, Text, Pressable, ActivityIndicator } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { Ionicons } from "@expo/vector-icons";
import { EmailCodeForm } from "./EmailCodeForm";
import { isLikelyEmail } from "@/lib/clerk-sign-in";

/** OAuth routes the hosted Clerk instance accepts. */
export type HostedAuthProvider = "google" | "github";

type HostedSignInPanelProps = {
  /** Which OAuth route is mid-flight, or null when idle. */
  loadingProvider: HostedAuthProvider | null;
  signingInWithPassword: boolean;
  sendingCode: boolean;
  verifyingCode: boolean;
  onGoogle: () => void;
  onGithub: () => void;
  onComputer: () => void;
  email: string;
  onEmailChange: (value: string) => void;
  password: string;
  onPasswordChange: (value: string) => void;
  passwordUnavailable: boolean;
  code: string;
  onCodeChange: (value: string) => void;
  codeSentTo: string | null;
  onSignIn: () => void;
  onSendCode: () => void;
  onVerify: () => void;
  onUseDifferentEmail: () => void;
};

export function HostedSignInPanel({
  loadingProvider,
  signingInWithPassword,
  sendingCode,
  verifyingCode,
  onGoogle,
  onGithub,
  onComputer,
  email,
  onEmailChange,
  password,
  onPasswordChange,
  passwordUnavailable,
  code,
  onCodeChange,
  codeSentTo,
  onSignIn,
  onSendCode,
  onVerify,
  onUseDifferentEmail,
}: HostedSignInPanelProps) {
  const busy = loadingProvider !== null || signingInWithPassword || sendingCode || verifyingCode;
  const emailReady = isLikelyEmail(email);

  return (
    <View style={styles.panel}>
      <EmailCodeForm
        email={email}
        onEmailChange={onEmailChange}
        password={password}
        onPasswordChange={onPasswordChange}
        passwordUnavailable={passwordUnavailable}
        code={code}
        onCodeChange={onCodeChange}
        codeSentTo={codeSentTo}
        signingIn={signingInWithPassword}
        verifying={verifyingCode}
        busy={busy}
        onSignIn={onSignIn}
        onVerify={onVerify}
        onUseDifferentEmail={onUseDifferentEmail}
      />

      {codeSentTo === null ? (
        <View style={styles.iconRow}>
          <SquareIconButton
            accessibilityLabel="Continue with Google"
            iconName="logo-google"
            loading={loadingProvider === "google"}
            disabled={busy}
            onPress={onGoogle}
          />
          <SquareIconButton
            accessibilityLabel="Continue with GitHub"
            iconName="logo-github"
            loading={loadingProvider === "github"}
            disabled={busy}
            onPress={onGithub}
          />
          <SquareIconButton
            accessibilityLabel="Email me a code instead"
            iconName="mail-outline"
            loading={sendingCode}
            disabled={busy || !emailReady}
            onPress={onSendCode}
          />
          <SquareIconButton
            accessibilityLabel="Sign in with a computer URL"
            iconName="desktop-outline"
            loading={false}
            disabled={busy}
            onPress={onComputer}
          />
        </View>
      ) : null}
    </View>
  );
}

function SquareIconButton({
  accessibilityLabel,
  iconName,
  onPress,
  loading,
  disabled,
}: {
  accessibilityLabel: string;
  iconName: keyof typeof Ionicons.glyphMap;
  onPress: () => void;
  loading: boolean;
  disabled: boolean;
}) {
  const { theme } = useUnistyles();

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.squareButton,
        pressed && styles.buttonPressed,
        disabled && styles.buttonDisabled,
      ]}
    >
      {loading ? (
        <ActivityIndicator size="small" color={theme.v2.appColors.ink} />
      ) : (
        <Ionicons name={iconName} size={22} color={theme.v2.appColors.ink} />
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => ({
  panel: {
    marginTop: 16,
    gap: 12,
  },
  iconRow: {
    flexDirection: "row",
    justifyContent: "center",
    gap: 12,
  },
  squareButton: {
    width: 56,
    height: 56,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.v2.radius.control,
    borderWidth: 1,
    borderColor: theme.v2.appColors.line,
    backgroundColor: theme.v2.appColors.surface,
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  buttonPressed: {
    opacity: 0.75,
    transform: [{ scale: 0.97 }],
  },
}));
