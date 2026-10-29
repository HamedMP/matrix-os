import type { z } from 'zod/v4';
import type { GoogleDataKindsSchema } from '../profiles.js';
type GoogleDataKind = z.infer<typeof GoogleDataKindsSchema>[number];

const textKinds: GoogleDataKind[] = ['gmail-metadata', 'gmail-content', 'google-derived-context'];
const attachmentKinds: GoogleDataKind[] = ['gmail-metadata', 'gmail-content', 'gmail-attachments', 'google-derived-context'];
const textActions = ['get_profile', 'list_threads', 'get_thread_ids', 'list_messages', 'get_message_text',
  'send_email', 'create_draft', 'search', 'list_labels', 'list_history', 'create_label', 'modify_message', 'delete_unused_label'];

/** Closed trusted map, independently checked by host and receiver. Full message
 * reads may contain inline attachment bytes; only the preflighted text action
 * may use a profile that excludes attachments. */
export function googleCollectionActionKinds(action: string): GoogleDataKind[] {
  if (action === 'get_message' || action === 'get_attachment') return [...attachmentKinds];
  if (textActions.includes(action)) return [...textKinds];
  throw new Error('Google data request unavailable');
}
