import { describe, expect, it } from 'vitest';

describe.skipIf(process.env.CUSTOMER_VPS_REAL_HETZNER !== 'true')('platform/customer-vps real Hetzner recovery smoke', () => {
  it('requires explicit operator fixtures before running recovery smoke', () => {
    expect(process.env.HETZNER_API_TOKEN).toBeTruthy();
    expect(process.env.CUSTOMER_VPS_SMOKE_CLERK_USER_ID).toBeTruthy();
  });
});
