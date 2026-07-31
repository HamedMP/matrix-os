import { View, Text, Pressable, ActivityIndicator, TextInput } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { Ionicons } from "@expo/vector-icons";

type SelfHostedSignInPanelProps = {
  username: string;
  onUsernameChange: (value: string) => void;
  password: string;
  onPasswordChange: (value: string) => void;
  connecting: boolean;
  /** True while any provider on the screen is mid-flight. */
  busy: boolean;
  onConnect: () => void;
};

/** Basic-auth connection for a self-hosted Matrix computer, which has no Clerk instance. */
export function SelfHostedSignInPanel({
  username,
  onUsernameChange,
  password,
  onPasswordChange,
  connecting,
  busy,
  onConnect,
}: SelfHostedSignInPanelProps) {
  const { theme } = useUnistyles();

  return (
    <View style={styles.panel}>
      <Text style={styles.panelTitle}>Basic Auth</Text>
      <View style={styles.fields}>
        <View style={styles.inputRow}>
          <Ionicons name="person-outline" size={17} color={theme.colors.inkMuted} />
          <TextInput
            value={username}
            onChangeText={onUsernameChange}
            placeholder="matrix"
            placeholderTextColor={theme.colors.inkDim}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="next"
            style={styles.input}
            accessibilityLabel="Basic auth username"
          />
        </View>
        <View style={styles.inputRow}>
          <Ionicons name="key-outline" size={17} color={theme.colors.inkMuted} />
          <TextInput
            value={password}
            onChangeText={onPasswordChange}
            placeholder="Installer password"
            placeholderTextColor={theme.colors.inkDim}
            autoCapitalize="none"
            autoCorrect={false}
            secureTextEntry
            textContentType="password"
            returnKeyType="go"
            onSubmitEditing={onConnect}
            style={styles.input}
            accessibilityLabel="Basic auth password"
          />
        </View>
      </View>
      <Pressable
        onPress={onConnect}
        disabled={busy}
        style={({ pressed }) => [
          styles.button,
          pressed && styles.buttonPressed,
          busy && styles.buttonDisabled,
        ]}
      >
        {connecting ? (
          <ActivityIndicator size="small" color={theme.colors.primaryForeground} />
        ) : (
          <>
            <Ionicons name="log-in-outline" size={19} color={theme.colors.primaryForeground} />
            <Text style={styles.buttonText}>Connect to self-hosted Matrix</Text>
          </>
        )}
      </Pressable>
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
  fields: {
    gap: 8,
  },
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
  button: {
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
  buttonDisabled: {
    opacity: 0.72,
  },
  buttonText: {
    fontFamily: theme.fonts.sansSemiBold,
    fontSize: 16,
    color: theme.colors.primaryForeground,
  },
  buttonPressed: {
    opacity: 0.85,
    transform: [{ scale: 0.98 }],
  },
}));
