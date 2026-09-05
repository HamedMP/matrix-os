import { View, Text, Pressable, TextInput } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { Ionicons } from "@expo/vector-icons";
import { HOSTED_GATEWAY_URL } from "@/lib/storage";

type GatewayUrlPanelProps = {
  url: string;
  onUrlChange: (value: string) => void;
  /** Normalises the typed URL, or reports why it is not a usable Matrix OS URL. */
  onUrlBlur: () => void;
  onUseCloud: () => void;
  error: string | null;
  selfHostedSelected: boolean;
  /** True while any provider on the screen is mid-flight. */
  busy: boolean;
};

/** Picks which Matrix computer the sign-in applies to. */
export function GatewayUrlPanel({
  url,
  onUrlChange,
  onUrlBlur,
  onUseCloud,
  error,
  selfHostedSelected,
  busy,
}: GatewayUrlPanelProps) {
  const { theme } = useUnistyles();

  return (
    <View style={styles.panel}>
      <Text style={styles.label}>Computer URL</Text>
      <View style={[styles.inputRow, error ? styles.inputRowError : null]}>
        <Ionicons name="server-outline" size={17} color={theme.v2.appColors.muted} />
        <TextInput
          value={url}
          onChangeText={onUrlChange}
          placeholder={HOSTED_GATEWAY_URL}
          placeholderTextColor={theme.v2.appColors.muted}
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="url"
          blurOnSubmit
          clearButtonMode="while-editing"
          keyboardType="url"
          textContentType="URL"
          returnKeyType="done"
          style={styles.input}
          onBlur={onUrlBlur}
          accessibilityLabel="Computer URL"
        />
      </View>
      {error ? (
        <Text selectable style={styles.error}>
          {error}
        </Text>
      ) : (
        <Text style={styles.hint}>
          {selfHostedSelected
            ? "Use the installer credentials shown after setup."
            : "Use the cloud URL, https:// domain, or http:// VPS IP."}
        </Text>
      )}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Use Matrix OS Cloud"
        disabled={busy}
        onPress={onUseCloud}
        style={({ pressed }) => [styles.link, pressed && styles.linkPressed]}
      >
        <Text style={styles.linkText}>Use Matrix OS Cloud</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  panel: {
    borderRadius: theme.v2.radius.container,
    borderWidth: 1,
    borderColor: theme.v2.appColors.line,
    backgroundColor: theme.v2.appColors.surface,
    padding: 14,
    gap: 8,
  },
  label: {
    fontFamily: theme.v2.fonts.semibold,
    fontSize: 13,
    color: theme.v2.appColors.ink,
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
    backgroundColor: theme.v2.appColors.canvas,
  },
  inputRowError: {
    borderColor: theme.v2.colors.danger,
  },
  input: {
    flex: 1,
    minWidth: 0,
    fontFamily: theme.v2.fonts.body,
    fontSize: 14,
    color: theme.v2.appColors.ink,
    paddingVertical: 10,
  },
  hint: {
    fontFamily: theme.v2.fonts.body,
    fontSize: 12,
    lineHeight: 17,
    color: theme.v2.appColors.muted,
  },
  error: {
    fontFamily: theme.v2.fonts.medium,
    fontSize: 12,
    lineHeight: 17,
    color: theme.v2.colors.danger,
  },
  link: {
    alignSelf: "flex-start",
    paddingVertical: 5,
    paddingHorizontal: 2,
  },
  linkPressed: {
    opacity: 0.85,
    transform: [{ scale: 0.98 }],
  },
  linkText: {
    fontFamily: theme.v2.fonts.semibold,
    fontSize: 12,
    color: theme.v2.colors.brand,
  },
}));
