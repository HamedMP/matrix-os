import type { ReactNode } from "react";
import { Text } from "react-native";
import { StartupScreen } from "@/components/StartupScreen";
import { nativeBuildTargetMatches } from "@/lib/native-callback-target";
import { useStartupColors } from "@/lib/use-startup-colors";

/** Stop an accidental cross-target Metro bundle before cached auth can mount. */
export function NativeBuildBoundary({ children }: { children: ReactNode }) {
  const colors = useStartupColors();
  if (!nativeBuildTargetMatches()) {
    return (
      <StartupScreen>
        <Text accessibilityRole="alert" style={{ color: colors.text, textAlign: "center" }}>Mobile connection unavailable</Text>
      </StartupScreen>
    );
  }
  return children;
}
