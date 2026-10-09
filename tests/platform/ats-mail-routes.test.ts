import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createAtsRoutes } from '../../packages/platform/src/ats-routes.js';
import { createAtsSlackTransport } from '../../packages/platform/src/ats-slack-api.js';
import { createTestAtsDb, destroyTestAtsDb } from './ats-db-test-helper.js';
import type { AtsDB } from '../../packages/platform/src/ats-db.js';
let db: AtsDB;
beforeEach(async () => { ({ db } = await createTestAtsDb()); });
afterEach(async () => { await destroyTestAtsDb(db); vi.unstubAllGlobals(); });
const input = { messageId: 'message1', threadId: '', senderName: 'Ada', senderEmail: 'ada@example.com', subject: 'Apply', body: 'Hello', receivedAt: '2026-10-09T10:00:00.000Z', sourceUrl: 'https://groups.google.com/a/finna.ai/g/careers', attachments: [{ filename: 'cv.pdf', contentType: 'application/pdf', base64: Buffer.from('%PDF-1.7').toString('base64') }] };
const app = () => createAtsRoutes({ db, ingestSecret: 'site', adminSecret: 'admin', mailSecret: 'mail', allowedRoleSlugs: ['founding-engineer'], bookingBaseUrl: 'https://cal.com/matrix' });
it('keeps group intake write-only and CVs/inbox private under the production route mounting', async () => {
  const routes = app();
  expect((await routes.request('/api/ats/mail',{method:'POST',body:JSON.stringify(input)})).status).toBe(401);
  const accepted = await routes.request('/api/ats/mail',{method:'POST',headers:{authorization:'Bearer mail','content-type':'application/json'},body:JSON.stringify(input)});
  expect(accepted.status).toBe(200);
  expect((await accepted.json()).receiptId).toBeDefined();
  for (const token of ['', 'mail', 'site']) expect((await routes.request('/api/ats/admin/inbox',{headers:{authorization:`Bearer ${token}`}})).status).toBe(401);
  const inbox = await routes.request('/api/ats/admin/inbox',{headers:{authorization:'Bearer admin'}});
  const { messages } = await inbox.json();
  expect(messages).toHaveLength(1);
  expect(messages[0].attachments[0].bytes).toBeUndefined();
  const path = `/api/ats/admin/attachments/${messages[0].attachments[0].id}`;
  expect((await routes.request(path,{headers:{authorization:'Bearer mail'}})).status).toBe(401);
  const cv = await routes.request(path,{headers:{authorization:'Bearer admin'}});
  expect(cv.headers.get('cache-control')).toContain('private');
  expect(await cv.text()).toBe('%PDF-1.7');
});
it('rejects malformed and oversized email and forbids applicant-controlled promotion actors', async () => {
  const routes = app();
  expect((await routes.request('/api/ats/mail',{method:'POST',headers:{authorization:'Bearer mail'},body:'{'})).status).toBe(422);
  expect((await routes.request('/api/ats/mail',{method:'POST',headers:{authorization:'Bearer mail'},body:'x'.repeat(32*1024*1024+1)})).status).toBe(413);
  const response = await routes.request('/api/ats/mail',{method:'POST',headers:{authorization:'Bearer mail'},body:JSON.stringify(input)});
  const { receiptId } = await response.json();
  expect((await routes.request(`/api/ats/admin/inbox/${receiptId}/promote`,{method:'POST',headers:{authorization:'Bearer admin'},body:JSON.stringify({roleSlug:'founding-engineer'})})).status).toBe(422);
  const promoted = await routes.request(`/api/ats/admin/inbox/${receiptId}/promote`,{method:'POST',headers:{authorization:'Bearer admin','x-ats-actor-id':'user_reviewer'},body:JSON.stringify({roleSlug:'founding-engineer'})});
  expect(promoted.status).toBe(200);
  const events = await db.executor.selectFrom('ats_application_events').selectAll().execute();
  expect(events[0].actor_id).toBe('user_reviewer');
});
it('renders applicant text as plain Slack text instead of workspace mentions and formatting', async () => {
  const request = vi.fn().mockResolvedValue(new Response(JSON.stringify({ok:true,ts:'123.456'})));
  vi.stubGlobal('fetch',request);
  await createAtsSlackTransport('test','C0123456789',db).post({key:'test',text:'<!here> <https://evil.example|click>',reviewUrl:'https://matrix-os.com/admin/ats/inbox'});
  const init = request.mock.calls[0][1];const body = JSON.parse(init.body);
  expect(body.mrkdwn).toBe(false);expect(body.parse).toBe('none');
  expect(body.blocks[0].text.type).toBe('plain_text');
  expect(init.redirect).toBe('error');expect(init.signal).toBeDefined();
});

it('limits Slack backfill to the authenticated admin bridge and bounded payloads',async()=>{
 const routes=app();const body=JSON.stringify({kind:'emails'});
 for(const token of ['', 'mail','site'])expect((await routes.request('/api/ats/admin/slack-backfill',{method:'POST',headers:{authorization:`Bearer ${token}`},body})).status).toBe(401);
 expect((await routes.request('/api/ats/admin/slack-backfill',{method:'POST',headers:{authorization:'Bearer admin'},body:JSON.stringify({kind:'emails',limit:201})})).status).toBe(422);
 expect((await routes.request('/api/ats/admin/slack-backfill',{method:'POST',headers:{authorization:'Bearer admin'},body})).status).toBe(200);
});
