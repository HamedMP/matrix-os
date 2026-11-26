import { useState } from "react";
import { Linking, Text as NativeText, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import * as Clipboard from "expo-clipboard";
import { Button, Text } from "@/components/ui";
import type { useGithubDeveloperSetup } from "@/lib/use-github-developer-setup";

type Setup = ReturnType<typeof useGithubDeveloperSetup>;
export function GithubDeveloperSetup({ setup }: { setup: Setup }) {
  if (!setup.view) return null;
  const { phase } = setup.view;
  const problem = phase === "failed" ? "Couldn't finish GitHub sign-in on this computer."
    : phase === "expired" ? "This GitHub code expired. Start again to get a new code."
      : phase === "cancelled" ? "GitHub sign-in was cancelled." : null;
  return (
    <View style={styles.workflow}>
      <View style={styles.panel}>
        {setup.view.phase === "waiting" ? <DeviceCode key={setup.view.code} code={setup.view.code} /> : null}
        {phase === "starting" ? <Text accessibilityLiveRegion="polite">Preparing GitHub sign-in…</Text> : null}
        {phase === "finishing" ? <Text accessibilityLiveRegion="polite">Checking the connection…</Text> : null}
        {problem ? <Text tone="action" accessibilityRole="alert">{problem}</Text> : null}
      </View>
      <View style={styles.actions}>
        <Button variant="outline" label={problem ? "Close" : "Cancel"} accessibilityLabel="Cancel GitHub setup" onPress={setup.dismiss} />
        {problem ? <Button label="Try again" disabled={setup.pending} onPress={() => void setup.start()} /> : null}
      </View>
    </View>
  );
}

function DeviceCode({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return <>
    <Text>Copy this code, then open GitHub and enter it to authorize this computer.</Text>
    <View style={styles.codeRow}>
      <NativeText selectable style={styles.deviceCode}>{code}</NativeText>
      <Button label={copied ? "Copied" : "Copy"} accessibilityLabel="Copy GitHub code" variant="secondary" onPress={() => {
        void Clipboard.setStringAsync(code).then(() => { setCopied(true); setError(null); }).catch((error: unknown) => {
          console.warn("[mobile] GitHub code copy failed", error instanceof Error ? error.name : "unknown");
          setError("Couldn't copy the code. You can select and copy it.");
        });
      }} />
    </View>
    <Button label="Open GitHub" onPress={() => {
      void Linking.openURL("https://github.com/login/device").then(() => setError(null)).catch((error: unknown) => {
        console.warn("[mobile] GitHub page open failed", error instanceof Error ? error.name : "unknown");
        setError("Couldn't open GitHub. Try again.");
      });
    }} />
    <Text tone="subtle" accessibilityLiveRegion="polite">Waiting for GitHub authorization…</Text>
    {error ? <Text tone="action" accessibilityRole="alert">{error}</Text> : null}
  </>;
}

const styles = StyleSheet.create((theme) => ({
  workflow: {
    gap: theme.v2.space[16],
    marginBottom: theme.v2.space[16],
  },
  panel: {
    gap: theme.v2.space[12],
    padding: theme.v2.space[16],
    borderWidth: theme.v2.borderWidth.hairline,
    borderColor: theme.v2.appColors.line,
    borderRadius: theme.v2.radius.card,
    backgroundColor: theme.v2.appColors.surface,
  },
  actions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.v2.space[12],
  },
  codeRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.v2.space[12],
    padding: theme.v2.space[12],
    borderRadius: theme.v2.radius.control,
    backgroundColor: theme.v2.appColors.canvas,
  },
  deviceCode: {
    ...theme.v2.text.subheading,
    fontFamily: theme.v2.fonts.mono,
    color: theme.v2.appColors.ink,
    flexShrink: 1,
  },
}));
