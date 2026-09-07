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
          <Ionicons name="person-outline" size={17} color={theme.v2.appColors.muted} />
          <TextInput
            value={username}
            onChangeText={onUsernameChange}
            placeholder="matrix"
            placeholderTextColor={theme.v2.appColors.muted}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="next"
            style={styles.input}
            accessibilityLabel="Basic auth username"
          />
        </View>
        <View style={styles.inputRow}>
          <Ionicons name="key-outline" size={17} color={theme.v2.appColors.muted} />
          <TextInput
            value={password}
            onChangeText={onPasswordChange}
            placeholder="Installer password"
            placeholderTextColor={theme.v2.appColors.muted}
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
          <ActivityIndicator size="small" color={theme.v2.colors.textInverse} />
        ) : (
          <>
            <Ionicons name="log-in-outline" size={19} color={theme.v2.colors.textInverse} />
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
    fontFamily: theme.v2.fonts.semibold,
    fontSize: 13,
    color: theme.v2.appColors.ink,
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
    borderRadius: theme.v2.radius.control,
    borderWidth: 1,
    borderColor: theme.v2.appColors.line,
    backgroundColor: theme.v2.appColors.surface,
  },
  input: {
    flex: 1,
    minWidth: 0,
    fontFamily: theme.v2.fonts.body,
    fontSize: 14,
    color: theme.v2.appColors.ink,
    paddingVertical: 10,
  },
  button: {
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
  buttonText: {
    fontFamily: theme.v2.fonts.semibold,
    fontSize: 16,
    color: theme.v2.colors.textInverse,
  },
  buttonPressed: {
    opacity: 0.85,
    transform: [{ scale: 0.98 }],
  },
}));
