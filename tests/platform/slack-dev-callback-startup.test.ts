import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { createSlackDevCallbackApp } from '../../packages/platform/src/slack-dev-callback-startup.js';
import { bootstrapPlatformSlack } from '../../packages/platform/src/slack-startup.js';

const origin = 'https://slack-dev-1a2b3c4d---matrix-platform-preview-example-ey.a.run.app';

describe('Slack Dev callback app', () => {
  it('reports health before enrollment and preserves the existing Slack unavailable response', async () => {
    const slack = await bootstrapPlatformSlack({
      env: { PLATFORM_PREVIEW: 'true' },
      db: {} as never,
      platformSecret: '',
      platformJwtSecret: '',
    });
    try {
      const app = createSlackDevCallbackApp(origin, slack.routes);
      expect(await (await app.request('/health')).json()).toEqual({ status: 'ok' });
      for (const [path, method] of [
        ['/webhooks/slack/events', 'POST'],
        ['/api/slack/install', 'POST'],
        ['/internal/slack/thread-context/access', 'POST'],
        ['/slack/link', 'GET'],
      ]) {
        const response = await app.request(new URL(path, origin), { method });
        expect(response.status).toBe(503);
        expect(await response.json()).toEqual({ error: 'Slack unavailable' });
      }
    } finally {
      await slack.close();
    }
  });

  it('preserves the tagged hostname through Cloud Run TLS termination and exposes no other routes', async () => {
    const routes = new Hono();
    routes.post('/webhooks/slack/events', c => c.json({ challenge: 'fixture' }));
    routes.all('*', c => c.json({ unrelated: true }));
    const app = createSlackDevCallbackApp(origin, routes);
    const taggedHttpOrigin = origin.replace('https:', 'http:');
    const response = await app.request(taggedHttpOrigin + '/webhooks/slack/events', { method: 'POST' });
    expect(await response.json()).toEqual({ challenge: 'fixture' });
    expect((await app.request('https://matrix-platform-preview-example-ey.a.run.app/webhooks/slack/events', {
      method: 'POST', headers: { 'x-forwarded-host': new URL(origin).host },
    })).status).toBe(404);
    for (const path of ['/', '/vps/register', '/vm/some-dev', '/api/auth/session', '/internal/collaboration']) {
      expect((await app.request(origin + path)).status).toBe(404);
    }
  });
});
