import type { AtsDB } from './ats-db.js';
import { createAtsSlackSender, deliverAtsNotifications } from './ats-notifications.js';

export function startAtsBackgroundWorker(db: AtsDB, env: NodeJS.ProcessEnv) {
  const fields = [env.ATS_SLACK_BOT_TOKEN, env.ATS_SLACK_CHANNEL_ID];
  if (fields.some(Boolean) && !fields.every(Boolean)) throw new Error('Incomplete ATS Slack configuration');
  if (!fields.every(Boolean)) return undefined;
  const send = createAtsSlackSender(fields[0]!, fields[1]!, env.MATRIX_PUBLIC_SITE_URL ?? 'https://matrix-os.com');
  let stopped = false;
  let running: Promise<void> | null = null;
  function tick() {
    if (stopped || running) return;
    running = deliverAtsNotifications(db, send)
      .catch((error) => console.error('[ats] Background delivery failed:', error instanceof Error ? error.name : typeof error))
      .finally(() => { running = null; });
  }
  const timer = setInterval(tick, 60_000);
  timer.unref();
  tick();
  return { async shutdown() { stopped = true; clearInterval(timer); await running; } };
}
