import { useState } from "react";
import { Platform } from "react-native";
import { SettingsCardStack, SettingsGroup, SettingsPage, SettingsRow, SettingsSwitchRow } from "./SettingsSurface";
import { Button, SectionLabel, Spacer, Text } from "@/components/ui";
import { DevicePushSettings } from "./DevicePushSettings";
import { NotificationChoiceSheet, type NotificationChoice } from "./NotificationChoiceSheet";
import type { useNotificationPreferences } from "@/lib/use-notification-preferences";
import type { NotificationComputer } from "@/lib/use-notification-computer";

const durations = [
  { value: 0, label: "Any length" }, { value: 10, label: "10 seconds" },
  { value: 30, label: "30 seconds" }, { value: 60, label: "1 minute" }, { value: 300, label: "5 minutes" },
] as const;
const delays = [
  { value: 0, label: "Immediately" }, { value: 30, label: "30 seconds" },
  { value: 60, label: "1 minute" }, { value: 120, label: "2 minutes" }, { value: 300, label: "5 minutes" },
] as const;
const modes = [
  { value: "when_away", label: "When away" }, { value: "always", label: "Always" }, { value: "never", label: "Never" },
] as const;
type Controller = ReturnType<typeof useNotificationPreferences>;

export function NotificationsSettingsView({ settings, computer }: { settings: Controller; computer: NotificationComputer }) {
  const [choice, setChoice] = useState<{ scope: Controller["scope"]; choice: NotificationChoice } | null>(null);
  const { draft, pending, conflict } = settings;
  const connected = computer.client !== null;
  return <SettingsPage>
    <Text>{computer.name ? `Notifications for ${computer.name}` : "No computer selected"}</Text>
    {computer.address ? <Text tone="subtle">{computer.address}</Text> : null}
    <Spacer size="md" /><SectionLabel>THIS COMPUTER</SectionLabel><Spacer size="md" />
    <DevicePushSettings computer={computer} />
    <Spacer size="md" /><Text tone="subtle">Other computers can still send notifications to this phone.</Text>
    <Spacer size="xl" />
    <Text tone="subtle">Preferences below apply to the selected Matrix computer.</Text>
    <Spacer size="md" />
    {!connected ? <Text tone="subtle">Connect a Matrix computer to manage notification settings.</Text> : null}
    {connected && !draft && pending ? <Text tone="subtle">Loading notification settings…</Text> : null}
    {settings.message ? <><Text accessibilityRole="alert">{settings.message}</Text><Spacer size="md" /></> : null}
    {connected && (!draft || conflict && !settings.latest) ? <Button label="Reload notification settings"
      variant="outline" loading={pending} onPress={() => void settings.reload()} /> : null}
    {draft ? <>
      <NotificationControls settings={settings} choose={(next) => setChoice({ scope: settings.scope, choice: next })} />
      {conflict ? <>
        <Text accessibilityRole="alert">Settings changed elsewhere. Your edits are still here. Choose which changes to keep before saving.</Text>
        <Spacer size="md" />
        {settings.latest ? <><Button label="Keep my changes" variant="outline" disabled={pending} onPress={() => settings.resolve(true)} />
          <Spacer size="md" /><Button label="Use latest" variant="text" disabled={pending} onPress={() => settings.resolve(false)} /><Spacer size="md" /></> : null}
      </> : null}
      {settings.saved ? <><Text tone="success" accessibilityLiveRegion="polite">Changes saved.</Text><Spacer size="md" /></> : null}
      <Button fullWidth label="Save" accessibilityLabel="Save notification settings" loading={pending}
        disabled={!settings.dirty || conflict} onPress={() => void settings.save()} />
    </> : null}
    <NotificationChoiceSheet choice={choice?.scope === settings.scope ? choice.choice : null} close={() => setChoice(null)} />
  </SettingsPage>;
}

function NotificationControls({ settings, choose }: { settings: Controller; choose: (choice: NotificationChoice) => void }) {
  const { draft, pending } = settings;
  if (!draft) return null;
  return <>
      <Text size="muted" tone="subtle">
        Notification kinds apply to current coding-agent alerts. Timing and content choices are saved for upcoming notification updates.
        To stop this computer’s pushes to this phone, turn off Push notifications above.
      </Text>
      <Spacer size="xl" /><SectionLabel>NOTIFY ME WHEN</SectionLabel><Spacer size="md" />
      <SettingsGroup>
        {([
          ["approval", "Task needs approval"], ["question", "Agent asks a question"],
          ["replyFinished", "Reply finishes"], ["runFailed", "Run fails"],
        ] as const).map(([key, title]) => <SettingsSwitchRow key={key} title={title} value={draft.events[key]}
          disabled={pending} onValueChange={(value) => settings.edit("events", key, value)} />)}
      </SettingsGroup>
      <Spacer size="md" />
      <SettingsCardStack>
        <SettingsRow card title="Minimum reply duration" accessibilityLabel="Minimum reply duration"
          detail={durations.find((item) => item.value === draft.events.minReplySeconds)?.label}
          onPress={pending ? undefined : () => choose({ title: "Minimum reply duration", value: draft.events.minReplySeconds,
            options: durations, choose: (value) => settings.edit("events", "minReplySeconds", value as typeof draft.events.minReplySeconds) })} />
      </SettingsCardStack>
      <Spacer size="xl" /><SectionLabel>PHONE</SectionLabel><Spacer size="md" />
      <SettingsGroup>
        <SettingsRow title="Send to phone" accessibilityLabel="Send to phone" detail={modes.find((item) => item.value === draft.phone.mode)?.label}
          onPress={pending ? undefined : () => choose({ title: "Send to phone", value: draft.phone.mode, options: modes,
            choose: (value) => settings.edit("phone", "mode", value as typeof draft.phone.mode) })} />
        <SettingsRow title="Send replies if still unread after" accessibilityLabel="Unread reply delay"
          detail={delays.find((item) => item.value === draft.phone.replyDelaySeconds)?.label}
          onPress={pending ? undefined : () => choose({ title: "Unread reply delay", value: draft.phone.replyDelaySeconds, options: delays,
            choose: (value) => settings.edit("phone", "replyDelaySeconds", value as typeof draft.phone.replyDelaySeconds) })} />
      </SettingsGroup>
      <Spacer size="xl" /><SectionLabel>CONTENT</SectionLabel><Spacer size="md" />
      <SettingsGroup>
        <SettingsSwitchRow title="Show previews" detail="Include chat titles and text in notifications"
          value={draft.content.showPreview} disabled={pending} onValueChange={(value) => settings.edit("content", "showPreview", value)} />
        <SettingsSwitchRow title="Sound" value={draft.content.sound} disabled={pending} onValueChange={(value) => settings.edit("content", "sound", value)} />
        {Platform.OS === "ios" ? <SettingsSwitchRow title="Time Sensitive" detail="Allow approvals and questions through Focus when iOS permits"
          value={draft.content.timeSensitive} disabled={pending} onValueChange={(value) => settings.edit("content", "timeSensitive", value)} /> : null}
      </SettingsGroup>
      <Spacer size="xl" />
  </>;
}
