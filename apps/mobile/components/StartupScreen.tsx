import type { ReactNode } from "react";
import { Image, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";

// The same artwork, at the same size and position, as the native splash screen
// (see the expo-splash-screen plugin in app.json), so the rabbit stays put
// when the splash hands over to this screen.
const splashArtwork = require("../assets/splash-icon.png");
const SPLASH_LOGO_SIZE = 100;

interface StartupScreenProps {
  /**
   * Leave the title out while the display font is still loading. Text laid
   * out before its font is registered is measured with the fallback face, and
   * that width is reused once the real font draws -- which clips the title.
   */
  showTitle?: boolean;
  /** Status content shown below the title: a spinner, a message, ... */
  children?: ReactNode;
}

/** The launch screen shown while the app boots: the rabbit, the Matrix OS title, and a status. */
export function StartupScreen({ showTitle = true, children }: StartupScreenProps) {
  return (
    <View style={styles.container}>
      <View style={styles.logoRow}>
        <Image
          source={splashArtwork}
          style={styles.logo}
          resizeMode="contain"
          accessibilityLabel="Matrix OS logo"
          testID="startup-logo"
        />
        <View style={styles.details} testID="startup-details">
          {showTitle ? <Text style={styles.title}>Matrix OS</Text> : null}
          {children}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    justifyContent: "center",
    backgroundColor: theme.colors.background,
  },
  logoRow: {
    height: SPLASH_LOGO_SIZE,
    alignItems: "center",
  },
  logo: {
    width: SPLASH_LOGO_SIZE,
    height: SPLASH_LOGO_SIZE,
  },
  // Hangs below the logo without taking part in the centering.
  details: {
    position: "absolute",
    top: SPLASH_LOGO_SIZE,
    left: 0,
    right: 0,
    alignItems: "center",
    paddingHorizontal: 24,
  },
  title: {
    fontFamily: theme.fonts.display,
    fontSize: 30,
    color: theme.colors.foreground,
    letterSpacing: -0.5,
  },
}));
