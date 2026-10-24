import { expect, it } from 'vitest';
import { ChatGptPlanPeerCapabilitiesSchema, ChatGptPlanPeerPollV2RequestSchema, ChatGptPlanPeerPollV2Schema, ChatGptPlanPeerPollSchema, ChatGptPlanPeerSessionSchema } from '@matrix-os/contracts';
const sessionId = '10000000-0000-4000-8000-000000000001';
const command = { version: 1, action: 'cancel', id: sessionId };
it('keeps v1 strict and accepts separately versioned session-bound receipts', () => {
  expect(ChatGptPlanPeerCapabilitiesSchema.safeParse({ version: 1, sessionId, pollDeliveryVersion: 2 }).success).toBe(true);
  expect(ChatGptPlanPeerSessionSchema.safeParse({ version: 1, sessionId, ackThrough: 0 }).success).toBe(false);
  expect(ChatGptPlanPeerPollSchema.safeParse({ version: 1, requests: [], acknowledgedThrough: 0 }).success).toBe(false);
  for (const ackThrough of [-1, 0.5, 281474976710656, Number.NaN]) {
    expect(ChatGptPlanPeerPollV2RequestSchema.safeParse({ version: 2, sessionId, ackThrough }).success).toBe(false);
  }
  expect(ChatGptPlanPeerPollV2RequestSchema.safeParse({ version: 2, sessionId, ackThrough: 0, owner: 'forged' }).success).toBe(false);
});
it('rejects gaps, duplicates, overflow, unknown keys and unbounded delivery arrays before dispatch', () => {
  const response = { version: 2, sessionId, acknowledgedThrough: 1, deliveries: [{ deliverySequence: 2, request: command }] };
  expect(ChatGptPlanPeerPollV2Schema.safeParse(response).success).toBe(true);
  for (const deliveries of [ [{ deliverySequence: 3, request: command }],
    [{ deliverySequence: 2, request: command }, { deliverySequence: 2, request: command }],
    Array.from({ length: 33 }, (_, i) => ({ deliverySequence: i + 2, request: command })),
    [{ deliverySequence: 2, request: { ...command, body: 'untrusted' } }],
  ]) expect(ChatGptPlanPeerPollV2Schema.safeParse({ ...response, deliveries }).success).toBe(false);
});
