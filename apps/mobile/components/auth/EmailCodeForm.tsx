import { View, Text, Pressable, ActivityIndicator, TextInput } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { Ionicons } from "@expo/vector-icons";
import {
  MAX_VERIFICATION_CODE_INPUT_LENGTH,
  isLikelyEmail,
  isValidVerificationCode,
  normalizeSignInIdentifier,
} from "@/lib/clerk-sign-in";

type EmailCodeFormProps = {
  email: string;
  onEmailChange: (value: string) => void;
  password: string;
  onPasswordChange: (value: string) => void;
  code: string;
  onCodeChange: (value: string) => void;
  /** Masked address Clerk sent the code to; null while still collecting credentials. */
  codeSentTo: string | null;
  /** True once Clerk has said this account has no password. */
  passwordUnavailable: boolean;
  signingIn: boolean;
  verifying: boolean;
  /** True while any provider on the screen is mid-flight. */
  busy: boolean;
  onSignIn: () => void;
  onVerify: () => void;
  onUseDifferentEmail: () => void;
};

export function EmailCodeForm({
  email,
  onEmailChange,
  password,
  onPasswordChange,
  code,
  onCodeChange,
  codeSentTo,
  passwordUnavailable,
  signingIn,
  verifying,
  busy,
  onSignIn,
  onVerify,
  onUseDifferentEmail,
}: EmailCodeFormProps) {
  const { theme } = useUnistyles();

  if (codeSentTo === null) {
    const emailReady = isLikelyEmail(email);
    const canSignIn = !busy && emailReady && password.length > 0;
    return (
      <>
        <View style={styles.inputRow}>
          <Ionicons name="mail-outline" size={17} color={theme.v2.appColors.muted} />
          <TextInput
            value={email}
            onChangeText={onEmailChange}
            placeholder="you@example.com"
            placeholderTextColor={theme.v2.appColors.muted}
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="email"
            keyboardType="email-address"
            textContentType="emailAddress"
            returnKeyType="next"
            onBlur={() => onEmailChange(normalizeSignInIdentifier(email))}
            style={styles.input}
            accessibilityLabel="Email address"
          />
        </View>
        <View style={styles.inputRow}>
          <Ionicons name="lock-closed-outline" size={17} color={theme.v2.appColors.muted} />
          <TextInput
            value={password}
            onChangeText={onPasswordChange}
            placeholder="Password"
            placeholderTextColor={theme.v2.appColors.muted}
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="current-password"
            secureTextEntry
            textContentType="password"
            returnKeyType="go"
            onSubmitEditing={() => {
              if (canSignIn) onSignIn();
            }}
            style={styles.input}
            accessibilityLabel="Password"
          />
        </View>
        <Pressable
          onPress={onSignIn}
          disabled={!canSignIn}
          style={({ pressed }) => [
            styles.buttonPrimary,
            pressed && styles.buttonPressed,
            !canSignIn && styles.buttonDisabled,
          ]}
        >
          {signingIn ? (
            <ActivityIndicator size="small" color={theme.v2.colors.textInverse} />
          ) : (
            <Text style={styles.buttonPrimaryText}>Sign in</Text>
          )}
        </Pressable>
        {passwordUnavailable ? (
          // Clerk told us this account has no password (an OAuth-only signup),
          // so point at the path that will actually work.
          <Text style={styles.hint}>
            That account has no password. Use a code, or continue with Google or GitHub.
          </Text>
        ) : null}
      </>
    );
  }

  const canVerify = !busy && isValidVerificationCode(code);
  return (
    <>
      <Text style={styles.hint}>We sent a 6-digit code to {codeSentTo}.</Text>
      <View style={styles.inputRow}>
        <Ionicons name="keypad-outline" size={17} color={theme.v2.appColors.muted} />
        <TextInput
          value={code}
          onChangeText={onCodeChange}
          placeholder="123456"
          placeholderTextColor={theme.v2.appColors.muted}
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="one-time-code"
          keyboardType="number-pad"
          textContentType="oneTimeCode"
          maxLength={MAX_VERIFICATION_CODE_INPUT_LENGTH}
          returnKeyType="go"
          onSubmitEditing={() => {
            if (canVerify) onVerify();
          }}
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
          <ActivityIndicator size="small" color={theme.v2.colors.textInverse} />
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
    minHeight: 52,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 14,
    borderRadius: theme.v2.radius.control,
    borderWidth: 1,
    borderColor: theme.v2.appColors.line,
    backgroundColor: theme.v2.appColors.surface,
  },
  input: {
    flex: 1,
    minWidth: 0,
    fontFamily: theme.v2.fonts.body,
    fontSize: 15,
    color: theme.v2.appColors.ink,
    paddingVertical: 10,
  },
  buttonPrimary: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    backgroundColor: theme.v2.colors.brand,
    borderRadius: theme.v2.radius.control,
    paddingVertical: 16,
  },
  buttonDisabled: {
    opacity: 0.55,
  },
  buttonPrimaryText: {
    fontFamily: theme.v2.fonts.semibold,
    fontSize: 16,
    color: theme.v2.colors.textInverse,
  },
  buttonPressed: {
    opacity: 0.85,
    transform: [{ scale: 0.98 }],
  },
  hint: {
    fontFamily: theme.v2.fonts.body,
    fontSize: 13,
    lineHeight: 18,
    color: theme.v2.appColors.muted,
  },
  link: {
    alignSelf: "center",
    paddingVertical: 5,
    paddingHorizontal: 2,
  },
  linkText: {
    fontFamily: theme.v2.fonts.semibold,
    fontSize: 13,
    color: theme.v2.colors.brand,
  },
}));
