import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { AppState, Linking, Platform, Pressable, Text, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { nativeApplicationVersion } from 'expo-application';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClientPolicyReader, evaluateClientPolicy, type ClientPolicyResponse } from '@matrix-os/contracts';

const CACHE_KEY = 'matrix-client-policy-v1';
export function ClientUpgradeGate({ origin, children, allowRecovery = false }: { origin: string; children: ReactNode; allowRecovery?: boolean }) {
  const { theme } = useUnistyles();
  const [result, setResult] = useState<{ origin: string; value: ClientPolicyResponse } | null>(null);
  const [error, setError] = useState(false);
  const reader = useMemo(() => createClientPolicyReader({
    target: Platform.OS === 'android' ? 'mobile-android' : 'mobile-ios',
    load: async () => { const value = await AsyncStorage.getItem(CACHE_KEY); return value && value.length <= 12_000 ? JSON.parse(value) : null; },
    save: value => AsyncStorage.setItem(CACHE_KEY, JSON.stringify(value)),
  }), []);
  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      try {
        const value = await reader.read(origin);
        if (!cancelled) setResult({ origin, value });
      } catch (err: unknown) { console.warn('[client-upgrade] Policy unavailable', err instanceof Error ? err.name : typeof err); }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 60_000);
    const subscription = AppState.addEventListener('change', state => { if (state === 'active') void refresh(); });
    return () => { cancelled = true; clearInterval(timer); subscription.remove(); };
  }, [origin, reader]);
  const policy = result?.origin === origin ? result.value.policy : null;
  const status = evaluateClientPolicy(policy, nativeApplicationVersion ?? '');
  if (allowRecovery || (status !== 'required' && status !== 'recommended')) return <>{children}</>;
  const required = status === 'required';
  async function openStore() {
    if (!policy) return;
    try { await Linking.openURL(policy.downloadUrl); setError(false); }
    catch (err: unknown) { setError(true); console.warn('[client-upgrade] Store unavailable', err instanceof Error ? err.name : typeof err); }
  }
  return <>
    {!required && children}
    <View accessibilityViewIsModal={required} style={{ ...(required ? { flex: 1, justifyContent: 'center' as const } : {}), padding: 24, gap: 16, backgroundColor: theme.colors.background }}>
      <Text accessibilityRole="header" style={{ color: theme.colors.foreground, fontSize: 22, fontFamily: theme.fonts.sansSemiBold }}>
        {required ? 'Update Matrix OS to continue' : 'A Matrix OS update is available'}
      </Text>
      <Text style={{ color: theme.colors.foreground }}>Update the app to keep using the latest Matrix OS features. Your cloud files remain safe.</Text>
      <Pressable accessibilityRole="button" onPress={() => void openStore()} style={{ paddingVertical: 14 }}>
        <Text style={{ color: theme.colors.primary, fontFamily: theme.fonts.sansSemiBold }}>Open app store</Text>
      </Pressable>
      {error && <Text accessibilityRole="alert" style={{ color: theme.colors.foreground }}>Could not open the store. Please try again.</Text>}
    </View>
  </>;
}
