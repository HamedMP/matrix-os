// Wire constants and types shared by the guest agent and the host's guest
// client. Kept apart from agent.ts so hostd's bundle never pulls in the
// agent's process entry point.

export const GUEST_AGENT_PORT = 1024;
export const MAX_LINE_BYTES = 4096;

export interface GuestStats {
  psiSome10: number;
  availableMiB: number;
  anonMiB: number;
}
