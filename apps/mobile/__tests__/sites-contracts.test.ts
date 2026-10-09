import { SiteUrlSchema } from '@matrix-os/contracts';
describe('shared public site URL contract', () => {
  it('loads through the shared contracts entrypoint and accepts only the public origin', () => {
    expect(SiteUrlSchema.safeParse('https://matrix.page/launch-2026').success).toBe(true);
    expect(SiteUrlSchema.safeParse('https://app.matrix-os.com/launch-2026').success).toBe(false);
  });
});
