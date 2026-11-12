import { useState } from "react";
import { Linking } from "react-native";
import * as Clipboard from "expo-clipboard";
import { Button, Spacer, Text } from "@/components/ui";
import type { useGithubDeveloperSetup } from "@/lib/use-github-developer-setup";

type Setup = ReturnType<typeof useGithubDeveloperSetup>;
export function GithubDeveloperSetup({ setup }: { setup: Setup }) {
  if (!setup.view) return null;
  const { phase } = setup.view;
  const problem = phase === "failed" ? "Couldn't finish GitHub sign-in on this computer."
    : phase === "expired" ? "This GitHub code expired. Start again to get a new code."
      : phase === "cancelled" ? "GitHub sign-in was cancelled." : null;
  return <>
    {setup.view.phase === "waiting" ? <DeviceCode key={setup.view.code} code={setup.view.code} /> : null}
    {phase === "starting" ? <Text accessibilityLiveRegion="polite">Preparing GitHub sign-in…</Text> : null}
    {phase === "finishing" ? <Text accessibilityLiveRegion="polite">Checking the connection…</Text> : null}
    {problem ? <Text tone="action" accessibilityRole="alert">{problem}</Text> : null}
    <Spacer size="md" />
    <Button variant="outline" label={problem ? "Close" : "Cancel"} accessibilityLabel="Cancel GitHub setup" onPress={setup.dismiss} />
    {problem ? <><Spacer size="md" /><Button label="Try again" disabled={setup.pending} onPress={() => void setup.start()} /></> : null}
    <Spacer size="lg" />
  </>;
}

function DeviceCode({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return <>
    <Text>Copy this code, then open GitHub and enter it to authorize this computer.</Text>
    <Spacer size="md" />
    <Text size="large" selectable align="center">{code}</Text>
    <Spacer size="md" />
    <Button label={copied ? "Copied" : "Copy"} accessibilityLabel="Copy GitHub code" variant="secondary" onPress={() => {
      void Clipboard.setStringAsync(code).then(() => { setCopied(true); setError(null); }).catch((error: unknown) => {
        console.warn("[mobile] GitHub code copy failed", error instanceof Error ? error.name : "unknown");
        setError("Couldn't copy the code. You can select and copy it.");
      });
    }} />
    <Spacer size="md" />
    <Button label="Open GitHub" onPress={() => {
      void Linking.openURL("https://github.com/login/device").then(() => setError(null)).catch((error: unknown) => {
        console.warn("[mobile] GitHub page open failed", error instanceof Error ? error.name : "unknown");
        setError("Couldn't open GitHub. Try again.");
      });
    }} />
    <Spacer size="md" />
    <Text tone="subtle" accessibilityLiveRegion="polite">Waiting for GitHub authorization…</Text>
    {error ? <><Spacer size="xs" /><Text tone="action" accessibilityRole="alert">{error}</Text></> : null}
  </>;
}
