import { useCallback, useRef, useState } from "react";
import { useFocusEffect, useRouter } from "expo-router";

import { useGateway } from "@/app/_layout";
import { SettingsCardStack, SettingsPage, SettingsRow } from "@/components/settings/SettingsSurface";
import { Button, Spacer, Text } from "@/components/ui";
import type { GithubDeveloperStatus } from "@/lib/gateway-client";
import { isSafeSessionId } from "@/lib/terminal-state";

const STATUS_ERROR = "Status unavailable";
const SETUP_ERROR = "Could not open the setup terminal. Try again.";

export default function DeveloperAccessSettingsScreen() {
  const router = useRouter();
  const { client } = useGateway();
  const [status, setStatus] = useState<GithubDeveloperStatus | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [statusError, setStatusError] = useState(false);
  const [setupError, setSetupError] = useState<string | null>(null);
  const [isStartingSetup, setIsStartingSetup] = useState(false);
  const refreshGeneration = useRef(0);
  const setupInFlight = useRef(false);

  const refreshStatus = useCallback(async () => {
    const generation = ++refreshGeneration.current;
    setIsRefreshing(true);
    setStatusError(false);
    try {
      if (!client) {
        setStatus(null);
        setStatusError(true);
        return;
      }
      const result = await client.getGithubDeveloperStatus();
      if (generation !== refreshGeneration.current) return;
      if (result.ok) {
        setStatus(result.status);
      } else {
        setStatus(null);
        setStatusError(true);
      }
    } finally {
      if (generation === refreshGeneration.current) setIsRefreshing(false);
    }
  }, [client]);

  useFocusEffect(
    useCallback(() => {
      void refreshStatus();
      return () => {
        refreshGeneration.current += 1;
      };
    }, [refreshStatus]),
  );

  const startSetup = async () => {
    if (!client || setupInFlight.current) return;
    setupInFlight.current = true;
    setIsStartingSetup(true);
    setSetupError(null);
    try {
      const terminalRef = await client.createGithubDeveloperSetupSession();
      if (!terminalRef || !isSafeSessionId(terminalRef)) {
        setSetupError(SETUP_ERROR);
        return;
      }
      router.push({
        pathname: "/terminal-session/[session]",
        params: { session: terminalRef },
      } as never);
    } catch (error: unknown) {
      console.warn("[mobile] GitHub developer setup failed", error instanceof Error ? error.name : "unknown");
      setSetupError(SETUP_ERROR);
    } finally {
      setupInFlight.current = false;
      setIsStartingSetup(false);
    }
  };

  const setupLabel = status?.authenticated ? "Finish setup" : "Connect";
  const setupAccessibilityLabel = status?.authenticated
    ? "Finish GitHub developer access setup"
    : "Connect GitHub developer access";
  const workflowCopy = status?.ready
    ? "Ready to clone, commit, push, and open pull requests."
    : statusError
      ? STATUS_ERROR
      : status
        ? "Setup required"
        : "Checking developer access…";

  return (
    <SettingsPage>
      <Text tone="subtle">
        Connect GitHub to this Matrix computer for private repositories and correctly attributed commits.
      </Text>
      <Spacer size="lg" />
      <SettingsCardStack>
        <SettingsRow card title="GitHub account" detail={accountDetail(status, isRefreshing)} />
        <SettingsRow card title="SSH access" detail={sshDetail(status, isRefreshing)} />
        <SettingsRow card title="Commit identity" detail={commitIdentityDetail(status, isRefreshing)} />
      </SettingsCardStack>
      <Spacer size="lg" />
      <Text tone={status?.ready ? "success" : "subtle"}>{workflowCopy}</Text>
      {statusError ? (
        <>
          <Spacer size="xs" />
          <Text tone="subtle">Refresh the status or finish setup in Terminal.</Text>
        </>
      ) : null}
      {setupError ? (
        <>
          <Spacer size="xs" />
          <Text tone="action">{setupError}</Text>
        </>
      ) : null}
      <Spacer size="lg" />
      {!status?.ready ? (
        <>
          <Button
            fullWidth
            label={setupLabel}
            accessibilityLabel={setupAccessibilityLabel}
            loading={isStartingSetup}
            disabled={!client}
            onPress={() => void startSetup()}
          />
          <Spacer size="md" />
        </>
      ) : null}
      <Button
        fullWidth
        variant="outline"
        label="Refresh"
        accessibilityLabel="Refresh GitHub developer access"
        loading={isRefreshing}
        disabled={!client}
        onPress={() => void refreshStatus()}
      />
    </SettingsPage>
  );
}

function accountDetail(status: GithubDeveloperStatus | null, refreshing: boolean): string {
  if (!status) return refreshing ? "Checking…" : "Unavailable";
  if (!status.installed) return "GitHub CLI unavailable";
  if (!status.authenticated) return "Setup required";
  return status.user ?? "Connected";
}

function sshDetail(status: GithubDeveloperStatus | null, refreshing: boolean): string {
  if (!status) return refreshing ? "Checking…" : "Unavailable";
  if (status.sshStatus === "verified") return "Verified";
  if (status.sshStatus === "setup_required") return "Setup required";
  return "Unavailable";
}

function commitIdentityDetail(status: GithubDeveloperStatus | null, refreshing: boolean): string {
  if (!status) return refreshing ? "Checking…" : "Unavailable";
  if (status.commitIdentity.status === "ready") return status.commitIdentity.label ?? "Ready";
  if (status.commitIdentity.status === "missing") return "Setup required";
  return "Unavailable";
}
