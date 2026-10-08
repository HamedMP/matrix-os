import { ActivityIndicator, View } from "react-native";
import * as AppleAuthentication from "expo-apple-authentication";
import { StyleSheet, useUnistyles } from "react-native-unistyles";

// The colours of Apple's system button, which Apple fixes: black on a light
// surface, white on a dark one. They are not brand tokens.
const APPLE_BLACK = "#000000";
const APPLE_WHITE = "#FFFFFF";

// The system button draws its title at about 43% of its own height and has no
// font size of its own, so the height is what sets the text size. 38pt gives a
// 16pt title, the size of the "Sign in" label above it.
const APPLE_BUTTON_HEIGHT = 38;

type AppleSignInButtonProps = {
  /** True while this button's own sign-in is running. */
  loading: boolean;
  /** True while any sign-in on the screen is running, this one included. */
  disabled: boolean;
  onPress: () => void;
};

/**
 * Apple's own "Sign in with Apple" button. The system draws, localises and
 * labels it, which is what keeps it within Apple's rules for the button; only
 * its size, corner radius and light or dark style are ours to set. The title
 * follows the height, so the two cannot be chosen separately.
 */
export function AppleSignInButton({ loading, disabled, onPress }: AppleSignInButtonProps) {
  const { theme } = useUnistyles();
  const onDarkSurface = theme.v2.mode === "dark";

  return (
    <View
      testID="apple-sign-in"
      pointerEvents={disabled ? "none" : "auto"}
      style={[styles.frame, disabled && !loading && styles.frameDisabled]}
    >
      <AppleAuthentication.AppleAuthenticationButton
        testID="apple-sign-in-button"
        buttonType={AppleAuthentication.AppleAuthenticationButtonType.SIGN_IN}
        buttonStyle={
          onDarkSurface
            ? AppleAuthentication.AppleAuthenticationButtonStyle.WHITE
            : AppleAuthentication.AppleAuthenticationButtonStyle.BLACK
        }
        cornerRadius={theme.v2.radius.control}
        style={styles.button}
        onPress={onPress}
      />
      {loading ? (
        <View
          style={[styles.progress, { backgroundColor: onDarkSurface ? APPLE_WHITE : APPLE_BLACK }]}
        >
          <ActivityIndicator size="small" color={onDarkSurface ? APPLE_BLACK : APPLE_WHITE} />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  frame: {
    height: APPLE_BUTTON_HEIGHT,
  },
  frameDisabled: {
    opacity: 0.5,
  },
  button: {
    width: "100%",
    height: "100%",
  },
  progress: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.v2.radius.control,
  },
}));
