import { describe, expect, it } from 'vitest';
import { googleCollectionActionKinds } from '../../packages/gateway/src/google-data/runtime/collection-action-kinds.js';
import { GMAIL_SERVICE } from '../../packages/gateway/src/integrations/gmail.js';

describe('action-specific Google collection kinds', () => {
  it('admits attachment-free text with the reviewed three kinds', () => {
    expect(googleCollectionActionKinds('get_message_text')).toEqual(['gmail-metadata', 'gmail-content', 'google-derived-context']);
  });
  it.each(['get_message', 'get_attachment'])('requires attachment permission for the unprojected %s action', action => {
    expect(googleCollectionActionKinds(action)).toContain('gmail-attachments');
  });
  it('covers every registered Gmail action and rejects unknown actions', () => {
    for (const action of Object.keys(GMAIL_SERVICE.actions)) expect(googleCollectionActionKinds(action)).toContain('google-derived-context');
    expect(() => googleCollectionActionKinds('future_unreviewed_read')).toThrow();
  });
});
