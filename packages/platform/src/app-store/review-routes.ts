import { Hono } from 'hono';
import { AppStoreReviewQueueQuerySchema, AppStoreReviewFileQuerySchema, AppStoreReviewDecisionSchema, AppStoreListingActionSchema } from '@matrix-os/contracts/app-store';
import { AppStoreError } from './errors.js';
import { parseStore, storeBody, storeId, type StoreRouteEnv, type StoreRouteDeps } from './internal-routes.js';
export function createStoreReviewRoutes(deps: StoreRouteDeps) {
  const app = new Hono<StoreRouteEnv>();
  app.use('*', async (c, next) => { if (!c.get('storeReviewer')) throw new AppStoreError('forbidden'); await next(); });
  app.get('/queue', async c => { const query = parseStore(AppStoreReviewQueueQuerySchema, c.req.query()); return c.json(await deps.repository.queue(query.status, query.cursor)); });
  app.get('/versions/:versionId', async c => {
    const id = storeId(c); if (!deps.review) throw new AppStoreError('unavailable'); return c.json(await deps.review.detail(id));
  });
  app.get('/versions/:versionId/file', async c => {
    const id = storeId(c); const query = parseStore(AppStoreReviewFileQuerySchema, c.req.query());
    if (!deps.review) throw new AppStoreError('unavailable'); return c.json(await deps.review.file(id, query.path, query.previous === '1'));
  });
  app.post('/versions/:versionId/decision', async c => {
    const id = storeId(c); const decision = parseStore(AppStoreReviewDecisionSchema, await storeBody(c));
    return c.json(await deps.repository.decide(c.get('storeActor').userId, id, decision));
  });
  app.post('/listings/:listingId/action', async c => {
    const id = storeId(c, 'listingId'); const action = parseStore(AppStoreListingActionSchema, await storeBody(c));
    return c.json(await deps.repository.listingAction(c.get('storeActor').userId, id, action));
  });
  return app;
}
