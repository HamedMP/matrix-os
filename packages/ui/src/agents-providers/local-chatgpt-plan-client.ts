/** Native public-client subscription custody. Only nonsecret presentation crosses IPC. */
export interface LocalChatgptPlanStatus {
  state: "disconnected" | "connecting" | "connected" | "error";
  scope: "this_device";
  account?: { id: string; label: string };
  models: Array<{ id: string; displayName: string }>;
  grant: { revision: number; enabled: boolean; background: boolean };
  bridgeConnected: boolean;
  revocation: "none" | "confirmed" | "unconfirmed";
}

export interface LocalChatgptPlanClient {
  status(signal: AbortSignal): Promise<LocalChatgptPlanStatus>;
  connect(input: { purpose: "personal_local" }, signal: AbortSignal): Promise<LocalChatgptPlanStatus>;
  cancel(signal: AbortSignal): Promise<LocalChatgptPlanStatus>;
  disconnect(signal: AbortSignal): Promise<LocalChatgptPlanStatus>;
  refreshModels(signal: AbortSignal): Promise<LocalChatgptPlanStatus>;
  setGrant(input: { enabled: boolean; background: false }, signal: AbortSignal): Promise<LocalChatgptPlanStatus>;
}
