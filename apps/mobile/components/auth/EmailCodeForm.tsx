import { View, Text, Pressable, ActivityIndicator, TextInput } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { Ionicons } from "@expo/vector-icons";
import { isLikelyEmail, isValidVerificationCode, normalizeSignInIdentifier } from "@/lib/clerk-sign-in";

type EmailCodeFormProps = {
  email: string;
  onEmailChange: (value: string) => void;
  code: string;
  onCodeChange: (value: string) => void;
  /** Masked address Clerk sent the code to; null while still collecting the address. */
  codeSentTo: string | null;
  sending: boolean;
  verifying: boolean;
  /** True while any provider on the screen is mid-flight. */
  busy: boolean;
  onSendCode: () => void;
  onVerify: () => void;
  onUseDifferentEmail: () => void;
};

export function EmailCodeForm({
  email,
  onEmailChange,
  code,
  onCodeChange,
  codeSentTo,
  sending,
  verifying,
  busy,
  onSendCode,
  onVerify,
  onUseDifferentEmail,
}: EmailCodeFormProps) {
  const { theme } = useUnistyles();

  if (codeSentTo === null) {
    const canSend = !busy && isLikelyEmail(email);
    return (
      <>
        <View style={styles.inputRow}>
          <Ionicons name="mail-outline" size={17} color={theme.colors.inkMuted} />
          <TextInput
            value={email}
            onChangeText={onEmailChange}
            placeholder="you@example.com"
            placeholderTextColor={theme.colors.inkDim}
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="email"
            keyboardType="email-address"
            textContentType="emailAddress"
            returnKeyType="go"
            onSubmitEditing={onSendCode}
            onBlur={() => onEmailChange(normalizeSignInIdentifier(email))}
            style={styles.input}
            accessibilityLabel="Email address"
          />
        </View>
        <Pressable
          onPress={onSendCode}
          disabled={!canSend}
          style={({ pressed }) => [
            styles.buttonSecondary,
            pressed && styles.buttonPressed,
            !canSend && styles.buttonDisabled,
          ]}
        >
          {sending ? (
            <ActivityIndicator size="small" color={theme.colors.foreground} />
          ) : (
            <>
              <Ionicons name="mail-outline" size={19} color={theme.colors.foreground} />
              <Text style={styles.buttonSecondaryText}>Email me a code</Text>
            </>
          )}
        </Pressable>
      </>
    );
  }

  const canVerify = !busy && isValidVerificationCode(code);
  return (
    <>
      <Text style={styles.hint}>We sent a 6-digit code to {codeSentTo}.</Text>
      <View style={styles.inputRow}>
        <Ionicons name="keypad-outline" size={17} color={theme.colors.inkMuted} />
        <TextInput
          value={code}
          onChangeText={onCodeChange}
          placeholder="123456"
          placeholderTextColor={theme.colors.inkDim}
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="one-time-code"
          keyboardType="number-pad"
          textContentType="oneTimeCode"
          maxLength={7}
          returnKeyType="go"
          onSubmitEditing={onVerify}
          style={styles.input}
          accessibilityLabel="Verification code"
        />
      </View>
      <Pressable
        onPress={onVerify}
        disabled={!canVerify}
        style={({ pressed }) => [
          styles.buttonPrimary,
          pressed && styles.buttonPressed,
          !canVerify && styles.buttonDisabled,
        ]}
      >
        {verifying ? (
          <ActivityIndicator size="small" color={theme.colors.primaryForeground} />
        ) : (
          <Text style={styles.buttonPrimaryText}>Verify and sign in</Text>
        )}
      </Pressable>
      <Pressable
        accessibilityRole="button"
        onPress={onUseDifferentEmail}
        disabled={busy}
        style={({ pressed }) => [styles.link, pressed && styles.buttonPressed]}
      >
        <Text style={styles.linkText}>Use a different email</Text>
      </Pressable>
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  inputRow: {
    minHeight: 50,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 14,
    borderRadius: theme.radius.lg,
    borderCurve: "continuous" as const,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.field,
  },
  input: {
    flex: 1,
    minWidth: 0,
    fontFamily: theme.fonts.sansMedium,
    fontSize: 14,
    color: theme.colors.foreground,
    paddingVertical: 10,
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
  hint: {
    fontFamily: theme.fonts.sans,
    fontSize: 13,
    lineHeight: 18,
    color: theme.colors.mutedForeground,
  },
  link: {
    alignSelf: "flex-start",
    paddingVertical: 5,
    paddingHorizontal: 2,
  },
  linkText: {
    fontFamily: theme.fonts.sansSemiBold,
    fontSize: 12,
    color: theme.colors.accentInk,
  },
}));
