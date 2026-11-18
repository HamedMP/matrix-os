export interface NativeCodexExecutionConsent {
  revision: number;
  harnessInstanceId: string;
  accountId: string;
  configurationFingerprint: string;
}
export function createNativeCodexExecutionProof(
  expected: string,
  environment: Record<string, string>,
  consent: NativeCodexExecutionConsent,
): Promise<(request: (method: string, params: unknown) => Promise<unknown>) => Promise<void>>;
export function assertNativeCodexThreadProvider(started: unknown): void;
export function verifyNativeCodexHumanControl(
  control: { type: string },
  verifyNativeSubscription: ((request: (method: string, params: unknown) => Promise<unknown>) => Promise<void>) | undefined,
  request: (method: string, params: unknown) => Promise<unknown>,
): Promise<void>;
