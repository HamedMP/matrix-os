import { expect, it } from 'vitest';
import { subscriptionCreditCycle } from '../../packages/platform/src/subscription-ai-credit-cycle.js';

it.each([
  ['2026-01-31T10:00:00.000Z', '2026-02-28T09:59:59.999Z', '2026-01-31T10:00:00.000Z', '2026-02-28T10:00:00.000Z'],
  ['2026-01-31T10:00:00.000Z', '2026-02-28T10:00:00.000Z', '2026-02-28T10:00:00.000Z', '2026-03-31T10:00:00.000Z'],
  ['2028-01-31T10:00:00.000Z', '2028-02-29T10:00:00.000Z', '2028-02-29T10:00:00.000Z', '2028-03-31T10:00:00.000Z'],
  ['2024-02-29T10:00:00.000Z', '2025-02-28T10:00:00.000Z', '2025-02-28T10:00:00.000Z', '2025-03-29T10:00:00.000Z'],
])('keeps the original anniversary after short months and leap years (%s, %s)', (anchor, now, start, end) => {
  expect(subscriptionCreditCycle(anchor, new Date(now))).toEqual({ start, end });
});
it('does not issue before the subscription anchor', () => {
  expect(subscriptionCreditCycle('2026-10-23T10:00:00.000Z', new Date('2026-10-22T10:00:00.000Z'))).toBeNull();
});
