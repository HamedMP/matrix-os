import { useCallback, useRef, useState } from "react";
import { useFocusEffect } from "expo-router";

import { useGateway } from "@/app/_layout";
import { SettingsCardStack, SettingsPage, SettingsRow } from "@/components/settings/SettingsSurface";
import { Button, Spacer, Text } from "@/components/ui";
import type { GithubDeveloperStatus } from "@/lib/github-developer-access";
import { useGithubDeveloperSetup } from "@/lib/use-github-developer-setup";
import { GithubDeveloperSetup } from "@/components/settings/GithubDeveloperSetup";

const STATUS_ERROR = "Status unavailable";

export default function DeveloperAccessSettingsScreen() {
  const { client } = useGateway();
  const [status, setStatus] = useState<GithubDeveloperStatus | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [statusError, setStatusError] = useState(false);
  const refreshGeneration = useRef(0);
  const refreshStatus = useCallback(async () => {
    const generation = ++refreshGeneration.current;
    setIsRefreshing(true);
    setStatusError(false);
    try {
      if (!client) {
        setStatus(null);
        setStatusError(true);
        return false;
      }
      const result = await client.getGithubDeveloperStatus();
      if (generation !== refreshGeneration.current) return false;
      if (result.ok) {
        setStatus(result.status);
        return result.status.ready;
      } else {
        setStatus(null);
        setStatusError(true);
        return false;
      }
    } catch (error: unknown) {
      console.warn("[mobile] GitHub status refresh failed", error instanceof Error ? error.name : "unknown");
      if (generation === refreshGeneration.current) {
        setStatus(null);
        setStatusError(true);
      }
      return false;
    } finally {
      if (generation === refreshGeneration.current) setIsRefreshing(false);
    }
  }, [client]);

  const setup = useGithubDeveloperSetup(client, refreshStatus);
  useFocusEffect(useCallback(() => {
    setStatus(null);
    void refreshStatus();
    return () => { refreshGeneration.current += 1; };
  }, [refreshStatus]));

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
        <SettingsRow card title="Commit identity" detail={commitIdentityDetail(status, isRefreshing)} detailNumberOfLines={0} />
      </SettingsCardStack>
      <Spacer size="lg" />
      <Text tone={status?.ready ? "success" : "subtle"}>{workflowCopy}</Text>
      {statusError ? (
        <>
          <Spacer size="xs" />
          <Text tone="subtle">Update this Matrix computer, then refresh and try again.</Text>
        </>
      ) : null}
      {status && !status.installed ? <><Spacer size="xs" /><Text tone="subtle">Update this Matrix computer to enable GitHub setup.</Text></> : null}
      <Spacer size="lg" />
      <GithubDeveloperSetup setup={setup} />
      {status?.installed && !status.ready && !setup.view ? (
        <>
          <Button fullWidth label={setupLabel} accessibilityLabel={setupAccessibilityLabel}
            loading={setup.pending} disabled={!client} onPress={() => void setup.start()} />
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
