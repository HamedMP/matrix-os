const PRODUCTION_ORIGIN = "https://app.matrix-os.com";
const PILOT_ORIGIN = "https://gmail-pilot.matrix-os.com";

function resolveHostedOrigin(value: string | undefined): string {
  if (value === undefined) return PRODUCTION_ORIGIN;
  if (value === PRODUCTION_ORIGIN || value === PILOT_ORIGIN) return value;
  throw new Error("Mobile hosted target unavailable");
}

// Expo statically substitutes this literal public setting into the JS bundle.
// User-entered URLs, stored selections and server replies never select it.
export const HOSTED_GATEWAY_URL = resolveHostedOrigin(process.env.EXPO_PUBLIC_MATRIX_HOSTED_ORIGIN);

/** Keep existing production keys unchanged; never restore/delete them in a pilot bundle. */
export function mobileHostedStorageKey(key: string): string {
  return HOSTED_GATEWAY_URL === PRODUCTION_ORIGIN ? key : `${key}.gmail-pilot`;
}

export interface MobileHostedStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

export function mobileHostedStorage(storage: MobileHostedStorage): MobileHostedStorage {
  if (HOSTED_GATEWAY_URL === PRODUCTION_ORIGIN) return storage;
  return Object.freeze({
    getItem: (key: string) => storage.getItem(mobileHostedStorageKey(key)),
    setItem: (key: string, value: string) => storage.setItem(mobileHostedStorageKey(key), value),
    removeItem: (key: string) => storage.removeItem(mobileHostedStorageKey(key)),
  });
}

export function isMatrixHostedHostname(hostname: string): boolean {
  return hostname === "app.matrix-os.com" || hostname === "gmail-pilot.matrix-os.com";
}

export function isMatrixHostedOrigin(origin: string): boolean {
  return origin === PRODUCTION_ORIGIN || origin === PILOT_ORIGIN;
}
