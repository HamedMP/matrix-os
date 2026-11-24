/** Non-secret fence; the trusted core still owns and injects the credential. */
export interface DesktopRequestSession {
  readonly authGeneration: number;
  readonly runtimeSlot: string;
}

export const DESKTOP_REQUEST_SESSION_HEADER = "X-Matrix-Session";

export function desktopRequestSessionKey(session: DesktopRequestSession): string {
  return JSON.stringify([session.authGeneration, session.runtimeSlot]);
}
