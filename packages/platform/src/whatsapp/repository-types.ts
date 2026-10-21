import type { Generated } from 'kysely';

export const WHATSAPP_AGENT_CONSENT_VERSION = 'whatsapp-general-agent-v1';
export interface WhatsAppConnection {
  id: string;
  owner: string;
  sender: string;
  chatId: string | null;
  machineId: string | null;
  consentVersion: string;
}
export interface WhatsAppJob {
  id: string;
  sender: string;
  payload: Record<string, unknown>;
  fence: string;
  attempts: number;
  expiresAt: number;
}
export type WhatsAppJobTerminalState = 'complete' | 'failed' | 'unknown';
export interface WhatsAppEnqueueInput {
  id: string;
  sender: string;
  payload: Record<string, unknown>;
  expiresAt: number;
}
export interface WhatsAppDatabase {
  whatsapp_connections: {
    id: string; owner: string; sender: string; chat_id: string | null; machine_id: string | null;
    consent_version: string; created_at: number;
  };
  whatsapp_link_challenges: {
    token_hash: string; request_id: string; sender: string; token_cipher: string;
    owner: string | null; code_hash: string | null; attempts: number;
    state: string; expires_at: number; created_at: number;
  };
  whatsapp_jobs: {
    id: string; sequence: Generated<number>; sender: string; payload: string | null;
    state: string; attempts: number; fence: string | null; lease_expires_at: number | null;
    available_at: number; expires_at: number; created_at: number; finished_at: number | null;
  };
}
