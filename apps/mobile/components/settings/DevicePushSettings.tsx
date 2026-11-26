import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Linking } from "react-native";
import { Button, Spacer, Text } from "@/components/ui";
import { SettingsSwitchRow } from "./SettingsSurface";
import type { NotificationComputer } from "@/lib/use-notification-computer";
import { disablePushNotifications, enablePushNotifications, isPushNotificationsEnabled, PushIdentityUnavailableError } from "@/lib/push";
import { queuePushChange, subscribePushTurnedOff } from "@/lib/push-registration-sync";

type Scope = { active: boolean; computer: NotificationComputer };
type PushState = { scope: Scope; enabled: boolean | null; target: boolean | null; error: boolean; identityUnavailable?: boolean; consentUnknown?: boolean };

export function DevicePushSettings({ computer }: { computer: NotificationComputer }) {
  const scope = useMemo<Scope>(() => ({ active: true, computer }), [computer]);
  const currentScope = useRef(scope);
  useLayoutEffect(() => { currentScope.current = scope; }, [scope]);
  const [state, setState] = useState<PushState>({ scope, enabled: null, target: null, error: false });
  const pending = useRef<typeof scope | null>(null);
  const current: PushState = state.scope === scope ? state : { scope, enabled: null, target: null, error: false };
  const active = () => scope.active && currentScope.current === scope;
  function change(update: Parameters<typeof setState>[0]) {
    if (scope.active && currentScope.current === scope) setState(update);
  }
  function readStatus() {
    return queuePushChange(async () => {
      if (!active() || !computer.client) return null;
      const session = await computer.session();
      if (!active()) return null;
      if (!session) throw new Error("Computer unavailable");
      return isPushNotificationsEnabled(session);
    });
  }
  async function reload() {
    if (!active() || pending.current === scope) return;
    pending.current = scope;
    change({ scope, enabled: null, target: null, error: false });
    try {
      const enabled = await readStatus();
      if (active()) change({ scope, enabled, target: null, error: false, consentUnknown: enabled === null && computer.client !== null });
    } catch (error: unknown) {
      console.warn("[mobile] Push status unavailable", error instanceof Error ? error.name : "unknown");
      if (active()) change({ scope, enabled: null, target: null, error: true, identityUnavailable: error instanceof PushIdentityUnavailableError });
    } finally {
      if (pending.current === scope) pending.current = null;
    }
  }
  useEffect(() => {
    scope.active = true;
    void reload();
    const unsubscribe = subscribePushTurnedOff((key) => {
      if (active() && key === computer.key) change((value) => ({ ...value, enabled: false, consentUnknown: false }));
    });
    return () => { scope.active = false; unsubscribe(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope]);
  async function toggle(enabled: boolean) {
    if (!active() || !computer.client || (current.enabled === null && !(current.consentUnknown || enabled && current.identityUnavailable)) || pending.current === scope) return;
    pending.current = scope;
    change({ ...current, scope, target: enabled, error: false });
    try {
      await queuePushChange(async () => {
        if (!active()) return;
        const session = await computer.session();
        if (!active()) return;
        if (!session) throw new Error("Computer unavailable");
        if (enabled) await enablePushNotifications(session);
        else await disablePushNotifications(session);
      });
      if (active()) change({ scope, enabled, target: null, error: false });
    } catch (error: unknown) {
      console.warn("[mobile] Push setting failed", error instanceof Error ? error.name : "unknown");
      let enabled: boolean | null = null;
      let identityUnavailable = false;
      let consentUnknown = false;
      try {
        enabled = await readStatus();
        consentUnknown = enabled === null;
      } catch (statusError: unknown) {
        console.warn("[mobile] Push reconciliation unavailable", statusError instanceof Error ? statusError.name : "unknown");
        identityUnavailable = statusError instanceof PushIdentityUnavailableError;
      }
      if (active()) change({ scope, enabled, target: null, error: true, identityUnavailable, consentUnknown });
    } finally {
      if (pending.current === scope) pending.current = null;
    }
  }
  return <DevicePushControls connected={computer.client !== null} current={current}
    toggle={(enabled) => void toggle(enabled)} reload={() => void reload()} />;
}

type PushControlProps = { current: Omit<PushState, "scope">; toggle: (enabled: boolean) => void; reload: () => void };

function DevicePushControls({ connected, current, toggle, reload }: PushControlProps & { connected: boolean }) {
  return <>
    <SettingsSwitchRow card title="Push notifications"
      detail={connected ? "Allow this phone to receive notifications from this computer" : "Connect a computer to enable"}
      value={current.target ?? current.enabled ?? false}
      disabled={!connected || current.enabled === null || current.target !== null}
      onValueChange={(enabled) => void toggle(enabled)} />
    {connected && current.enabled === null && !current.error && !current.consentUnknown ? <>
      <Spacer size="md" /><Text tone="subtle">Checking this computer’s push registration…</Text>
    </> : null}
    {connected && current.consentUnknown ? <>
      <Spacer size="md" /><Text accessibilityRole="alert">Your notification choice for this computer needs confirmation.</Text>
      <Spacer size="md" /><Button label="Enable for this computer" variant="outline" loading={current.target === true}
        disabled={current.target !== null} onPress={() => void toggle(true)} />
      <Spacer size="md" /><Button label="Keep off for this computer" variant="text" loading={current.target === false}
        disabled={current.target !== null} onPress={() => void toggle(false)} />
    </> : null}
    {current.error ? <DevicePushError current={current} toggle={toggle} reload={reload} /> : null}
  </>;
}

function DevicePushError({ current, toggle, reload }: PushControlProps) {
  return <>
      <Spacer size="md" />
      <Text accessibilityRole="alert">{current.consentUnknown
        ? "Couldn’t save this computer’s notification choice. Try again."
        : current.identityUnavailable
        ? "This phone’s push registration is unknown. Enable notifications or check permissions to continue."
        : current.enabled === null
        ? "Couldn’t load this computer’s push registration. Update this computer or try again."
        : "Couldn’t update push notifications. Check notification permissions and try again."}</Text>
      {current.identityUnavailable ? <Button label="Enable for this computer" variant="outline" onPress={() => void toggle(true)} /> : null}
      <Button label="Reload push registration" variant="outline" onPress={() => void reload()} />
      <Button label="Open notification permissions" variant="text" onPress={() => {
        void Linking.openSettings().catch((error: unknown) => {
          console.warn("[mobile] Notification permissions unavailable", error instanceof Error ? error.name : "unknown");
        });
      }} />
  </>;
}
