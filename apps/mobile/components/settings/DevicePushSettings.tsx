import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Linking } from "react-native";
import { Button, Spacer, Text } from "@/components/ui";
import { SettingsSwitchRow } from "./SettingsSurface";
import { useActiveGateway } from "@/lib/queries/use-active-gateway";
import { disablePushNotifications, enablePushNotifications, isPushNotificationsEnabled } from "@/lib/push";
import { queuePushChange, subscribePushTurnedOff } from "@/lib/push-registration-sync";

export function DevicePushSettings() {
  const gateway = useActiveGateway();
  const scope = useMemo(() => ({ active: true, gatewayUrl: gateway.gatewayUrl, userId: gateway.userId }), [gateway.gatewayUrl, gateway.userId]);
  const currentScope = useRef(scope);
  useLayoutEffect(() => { currentScope.current = scope; }, [scope]);
  const [state, setState] = useState({ scope, enabled: null as boolean | null, target: null as boolean | null, error: false });
  const pending = useRef<typeof scope | null>(null);
  const current = state.scope === scope ? state : { scope, enabled: null, target: null, error: false };
  const active = () => scope.active && currentScope.current === scope;
  useEffect(() => {
    scope.active = true;
    void isPushNotificationsEnabled().then((enabled) => {
      if (active()) setState({ scope, enabled, target: null, error: false });
    }).catch((error: unknown) => {
      console.warn("[mobile] Push status unavailable", error instanceof Error ? error.name : "unknown");
      if (active()) setState({ scope, enabled: null, target: null, error: true });
    });
    const unsubscribe = subscribePushTurnedOff(() => {
      if (active()) setState((value) => ({ ...value, enabled: false }));
    });
    return () => { scope.active = false; unsubscribe(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope]);
  async function toggle(enabled: boolean) {
    if (!gateway.ready || current.enabled === null || pending.current === scope) return;
    pending.current = scope;
    setState({ scope, enabled: current.enabled, target: enabled, error: false });
    try {
      await queuePushChange(async () => {
        if (!active()) return;
        const session = await gateway.session();
        if (!active()) return;
        if (!session) throw new Error("Computer unavailable");
        const input = { clerkToken: session.token, gatewayUrl: session.gatewayUrl };
        if (enabled) await enablePushNotifications(input);
        else await disablePushNotifications(input);
      });
      if (active()) setState({ scope, enabled, target: null, error: false });
    } catch (error: unknown) {
      console.warn("[mobile] Push setting failed", error instanceof Error ? error.name : "unknown");
      if (active()) setState((value) => ({ ...value, target: null, error: true }));
    } finally {
      if (pending.current === scope) pending.current = null;
    }
  }
  return <>
    <SettingsSwitchRow card title="Push notifications"
      detail={gateway.ready ? "Allow this phone to receive notifications from this computer" : "Connect a computer to enable"}
      value={current.target ?? current.enabled ?? false}
      disabled={!gateway.ready || current.enabled === null || current.target !== null}
      onValueChange={(enabled) => void toggle(enabled)} />
    {current.error ? <>
      <Spacer size="md" />
      <Text accessibilityRole="alert">Couldn’t update push notifications. Check notification permissions and try again.</Text>
      <Button label="Open notification permissions" variant="text" onPress={() => {
        void Linking.openSettings().catch((error: unknown) => {
          console.warn("[mobile] Notification permissions unavailable", error instanceof Error ? error.name : "unknown");
        });
      }} />
    </> : null}
  </>;
}
