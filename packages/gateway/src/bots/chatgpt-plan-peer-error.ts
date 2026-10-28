export class ChatGptPlanPeerError extends Error {
  constructor(readonly code: 'forbidden' | 'invalid_request' | 'unavailable' | 'conflict') { super(code); }
}
