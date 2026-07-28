import { View, Text, Pressable, ActivityIndicator } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { Ionicons } from "@expo/vector-icons";
import { EmailCodeForm } from "./EmailCodeForm";

/** OAuth routes the hosted Clerk instance accepts. */
export type HostedAuthProvider = "google" | "github";

type HostedSignInPanelProps = {
  /** Which OAuth route is mid-flight, or null when idle. */
  loadingProvider: HostedAuthProvider | "basic" | null;
  signingInWithPassword: boolean;
  sendingCode: boolean;
  verifyingCode: boolean;
  onGoogle: () => void;
  onGithub: () => void;
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
  const { theme } = useUnistyles();
  const busy = loadingProvider !== null || signingInWithPassword || sendingCode || verifyingCode;

  return (
    <View style={styles.panel}>
      <Text style={styles.panelTitle}>Sign in to this computer</Text>
      <Pressable
        onPress={onGoogle}
        disabled={busy}
        style={({ pressed }) => [
          styles.buttonPrimary,
          pressed && styles.buttonPressed,
          busy && styles.buttonDisabled,
        ]}
      >
        {loadingProvider === "google" ? (
          <ActivityIndicator size="small" color={theme.colors.primaryForeground} />
        ) : (
          <>
            <Ionicons name="logo-google" size={19} color={theme.colors.primaryForeground} />
            <Text style={styles.buttonPrimaryText}>Continue with Google</Text>
          </>
        )}
      </Pressable>
      <Pressable
        onPress={onGithub}
        disabled={busy}
        style={({ pressed }) => [
          styles.buttonSecondary,
          pressed && styles.buttonPressed,
          busy && styles.buttonDisabled,
        ]}
      >
        {loadingProvider === "github" ? (
          <ActivityIndicator size="small" color={theme.colors.foreground} />
        ) : (
          <>
            <Ionicons name="logo-github" size={20} color={theme.colors.foreground} />
            <Text style={styles.buttonSecondaryText}>Continue with GitHub</Text>
          </>
        )}
      </Pressable>

      <View style={styles.divider}>
        <View style={styles.dividerRule} />
        <Text style={styles.dividerText}>or</Text>
        <View style={styles.dividerRule} />
      </View>

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
        sending={sendingCode}
        verifying={verifyingCode}
        busy={busy}
        onSignIn={onSignIn}
        onSendCode={onSendCode}
        onVerify={onVerify}
        onUseDifferentEmail={onUseDifferentEmail}
      />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  panel: {
    marginTop: 16,
    gap: 10,
  },
  panelTitle: {
    fontFamily: theme.fonts.sansSemiBold,
    fontSize: 13,
    color: theme.colors.foreground,
  },
  buttonPrimary: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
    backgroundColor: theme.colors.primary,
    borderRadius: theme.radius.lg,
    borderCurve: "continuous" as const,
    borderWidth: 1,
    borderColor: theme.colors.primary,
    paddingVertical: 16,
    paddingHorizontal: 24,
    boxShadow: "0 10px 22px rgba(194, 112, 58, 0.18)",
  },
  buttonSecondary: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
    backgroundColor: theme.colors.card,
    borderRadius: theme.radius.lg,
    borderCurve: "continuous" as const,
    borderWidth: 1,
    borderColor: theme.colors.border,
    paddingVertical: 15,
    paddingHorizontal: 24,
  },
  buttonDisabled: {
    opacity: 0.72,
  },
  buttonPrimaryText: {
    fontFamily: theme.fonts.sansSemiBold,
    fontSize: 16,
    color: theme.colors.primaryForeground,
  },
  buttonSecondaryText: {
    fontFamily: theme.fonts.sansSemiBold,
    fontSize: 16,
    color: theme.colors.foreground,
  },
  buttonPressed: {
    opacity: 0.85,
    transform: [{ scale: 0.98 }],
  },
  divider: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    marginVertical: 2,
  },
  dividerRule: {
    flex: 1,
    height: 1,
    backgroundColor: theme.colors.border,
  },
  dividerText: {
    fontFamily: theme.fonts.sansMedium,
    fontSize: 12,
    color: theme.colors.mutedForeground,
  },
}));
