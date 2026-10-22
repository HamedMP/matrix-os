export type GoogleDataPilotConfig = { enabled: false } | { enabled: true; ownerId: string };
export class GoogleDataPilotError extends Error { constructor() { super('Google pilot unavailable'); this.name = 'GoogleDataPilotError'; } }
/** Operator host configuration only. This enables stricter controls, never provider/profile/consent access. */
export function loadGoogleDataPilotConfig(env: NodeJS.ProcessEnv, runtimeOwnerId: string | undefined): GoogleDataPilotConfig {
  const flag = env.MATRIX_GOOGLE_DATA_PILOT_ENABLED;
  if (flag === undefined || flag === 'false' || flag === '0') return { enabled: false };
  const owner = env.MATRIX_USER_ID ?? env.MATRIX_CLERK_USER_ID;
  if (flag !== 'true' || !owner || !/^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,159}$/.test(owner)
    || !runtimeOwnerId || owner !== runtimeOwnerId) throw new GoogleDataPilotError();
  return Object.freeze({ enabled: true, ownerId: owner });
}
