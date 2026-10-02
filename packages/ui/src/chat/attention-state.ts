import type { CanonicalChatRecord } from '@matrix-os/contracts';
import { isChatUnread } from './read-state.js';

export type CanonicalChatAttentionState = 'approval_required' | 'input_required' | 'running' | 'failed' | 'unseen_completion' | 'idle';
/** One presentation derivation for authenticated canonical records across clients. */
export function resolveCanonicalChatAttention(record: CanonicalChatRecord): CanonicalChatAttentionState {
  if (record.chat.attention === 'approval_required' || record.activeRun?.status === 'waiting_for_approval') return 'approval_required';
  if (record.chat.attention === 'input_required' || record.activeRun?.status === 'waiting_for_input') return 'input_required';
  if (record.activeRun) return 'running';
  if (record.chat.attention === 'failed') return 'failed';
  return isChatUnread(record) ? 'unseen_completion' : 'idle';
}
