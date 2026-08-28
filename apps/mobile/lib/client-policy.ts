import { nativeApplicationVersion } from 'expo-application';
import { Platform } from 'react-native';
import { ClientVersionSchema } from '@matrix-os/contracts';

/** Development builds without a valid native version remain unidentified. */
export function mobileClientHeaders(): Record<string, string> {
  const version = ClientVersionSchema.safeParse(nativeApplicationVersion);
  return version.success ? {
    'x-matrix-client-target': Platform.OS === 'android' ? 'mobile-android' : 'mobile-ios',
    'x-matrix-client-version': version.data,
  } : {};
}
