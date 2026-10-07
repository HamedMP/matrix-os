import { z } from 'zod/v4';
import { sql, type Transaction } from 'kysely';
import { parseNullableProviderActionId, type PlatformDatabase, type PlatformDB } from '../db.js';
import type { CustomerVpsService } from '../customer-vps.js';
import type { HetznerClient } from '../customer-vps-hetzner.js';
import { CustomerVpsError } from '../customer-vps-errors.js';
import { createAppleRevoker, prepareClerkAppleRevocation, assertAppleDeletionConfig, type AppleDeletionConfig } from './apple.js';
import { assertDeletionOwnershipSafe, eraseOwnerPlatformData, hasTable } from './cleanup-data.js';
import { revokeOwnerMatrixCredentials } from './matrix.js';
import { ownerHandlesQuery } from './owner-handles.js';
import { readNativeAppleCredential } from './native-apple.js';
import { projectAccountDeletionBillingCancellation } from './billing-projection.js';
import { eraseOwnerStorage, type AccountDeletionObjectStore } from './storage.js';
import { AccountDeletionOwnershipError, type AccountDeletionAdapters, type AccountDeletionContext } from './types.js';

export interface AccountDeletionAdapterOptions {
  db: PlatformDB;
  clerkSecretKey: string;
  customerVpsService?: Pick<CustomerVpsService, 'delete'>;
  hetzner?: Pick<HetznerClient, 'getServer' | 'deleteServer' | 'listServersByLabel'> & Partial<Pick<HetznerClient, 'getAction'>>;
  objectStore?: AccountDeletionObjectStore;
  r2PrefixRoot: string;
  stripeSecretKey?: string;
  ownerHash?: (owner: string) => string;
  credentialSecret?: string;
  matrixHomeserverUrl?: string;
  apple?: AppleDeletionConfig;
  nativeGmail?: { revoke(input: { userId: string; connectionId: string }): Promise<boolean> };
  pipedream?: { listAccounts(externalUserId: string): Promise<Array<{ id: string }>>; revokeAccount(id: string): Promise<void> };
  customMcp?: { remove(userId: string, serverId: string): Promise<void> };
  twilio?: { accountSid: string; authToken: string; publicBaseUrl: string };
  fetch?: typeof fetch;
}
const userSchema = z.object({ external_accounts: z.array(z.object({ provider: z.string(), id: z.string() })).max(100),
  private_metadata: z.record(z.string(), z.unknown()).default({}) });
export function createAccountDeletionAdapters(options: AccountDeletionAdapterOptions): AccountDeletionAdapters {
  if (!options.clerkSecretKey) throw new Error('Account deletion identity configuration unavailable');
  const request = options.fetch ?? fetch;
  const db = options.db;
  async function clerk(path: string, method = 'GET', allowNotFound = false): Promise<unknown | null> {
    const response = await request(`https://api.clerk.com/v1${path}`, { method, redirect: 'error',
      signal: AbortSignal.timeout(10_000), headers: { Authorization: `Bearer ${options.clerkSecretKey}` } });
    if (response.status === 404 && allowNotFound) { await response.body?.cancel(); return null; }
    if (!response.ok) throw new Error('Identity cleanup unavailable');
    if (method === 'DELETE') { await response.body?.cancel(); return null; }
    return response.json();
  }
  async function assertClerkOwnershipSafe(owner:string,allowDeleted=false):Promise<void> {
    // Clerk remains membership authority; stale platform projections cannot authorize sole-owner deletion.
    for (let offset = 0; offset < 1000; offset += 100) {
      const value = await clerk(`/users/${encodeURIComponent(owner)}/organization_memberships?limit=100&offset=${offset}`, 'GET', allowDeleted);
      if(value===null && allowDeleted) return;
      const memberships = z.object({ data: z.array(z.object({ role: z.string(), organization: z.object({ id: z.string() }) })).max(100),
        total_count: z.number().int().nonnegative().max(1000) }).parse(value);
      for (const membership of memberships.data) {
        if (!['org:admin','org:owner','owner'].includes(membership.role)) continue;
        const admins = z.object({ data: z.array(z.object({ role: z.string(), public_user_data: z.object({ user_id: z.string() }) })).max(100),
          total_count: z.number().int().nonnegative() }).parse(await clerk(
          `/organizations/${encodeURIComponent(membership.organization.id)}/memberships?limit=100`));
        if (!admins.data.some((member) => member.public_user_data.user_id !== owner && ['org:admin','org:owner','owner'].includes(member.role))) {
          throw new AccountDeletionOwnershipError();
        }
      }
      if (offset + memberships.data.length >= memberships.total_count) break;
      if (!memberships.data.length || offset === 900) throw new Error('Ownership inventory unavailable');
    }
  }
  async function prepare(owner: string, identityDeleted = false, transaction?: Transaction<PlatformDatabase>): Promise<AccountDeletionContext> {
    z.string().regex(/^user_[A-Za-z0-9_-]{1,150}$/).parse(owner);
    await db.ready;
    await assertDeletionOwnershipSafe(transaction ? {...db,executor:transaction} : db, owner);
    const userValue = await clerk(`/users/${encodeURIComponent(owner)}`, 'GET', identityDeleted);
    if (!userValue) return { clerkUserId: owner, appleTokens: [], appleRevocationUnknown: true, manualAppleRevocationRequired: true };
    const user = userSchema.parse(userValue);
    await assertClerkOwnershipSafe(owner);
    if (!user.external_accounts.some((account) => ['oauth_apple','apple'].includes(account.provider))) {
      return { clerkUserId: owner, appleTokens: [] };
    }
    if (!options.apple) throw new Error('Apple revocation configuration unavailable');
    await assertAppleDeletionConfig(options.apple);
    const nativeCredential=options.credentialSecret
      ? readNativeAppleCredential(user.private_metadata,owner,options.credentialSecret):null;
    if(user.private_metadata.matrix_native_apple_credential && !options.credentialSecret) throw new Error('Apple credential encryption unavailable');
    if(nativeCredential && nativeCredential.clientId!==options.apple.nativeClientId) throw new Error('Apple credential provenance mismatch');
    const tokens = await clerk(`/users/${encodeURIComponent(owner)}/oauth_access_tokens/oauth_apple`);
    if(nativeCredential && Array.isArray(tokens) && !tokens.length) return {clerkUserId:owner,appleTokens:[nativeCredential]};
    const prepared = await prepareClerkAppleRevocation(tokens, user.private_metadata.matrix_apple_token_client_ids ?? {}, options.apple, request);
    return { clerkUserId: owner, appleTokens: [...(nativeCredential ? [nativeCredential] : []), ...prepared.tokens],
      ...(prepared.manualRevocationRequired ? { manualAppleRevocationRequired: true } : {}) };
  }
  return {
    prepare,
    async billing(context) {
      const owner = context.clerkUserId;
      const customers = await db.executor.selectFrom('billing_customers').select('stripe_customer_id').where('clerk_user_id','=',owner).execute();
      const subscriptions = await db.executor.selectFrom('billing_subscriptions').select(['stripe_subscription_id','stripe_customer_id'])
        .where('clerk_user_id','=',owner).where('status','not in',['canceled','incomplete_expired']).limit(1001).execute();
      const entitlements = await db.executor.selectFrom('billing_entitlements').select('stripe_subscription_id')
        .where('clerk_user_id','=',owner).where('source','=','stripe').limit(1001).execute();
      const checkoutAttempts = await db.executor.selectFrom('billing_checkout_attempts').select('stripe_session_id')
        .where('clerk_user_id','=',owner).where('status','in',['creating','open']).where('stripe_session_id','is not',null).limit(1001).execute();
      const creditCheckouts = await db.executor.selectFrom('ai_credit_checkout_claims').select('stripe_session_id')
        .where('owner_id','=',owner).where('status','in',['creating','open','awaiting_payment']).where('stripe_session_id','is not',null).limit(1001).execute();
      const projectionEnv = options.credentialSecret ? {ACCOUNT_DELETION_SECRET:options.credentialSecret} : process.env;
      if (!customers.length && !subscriptions.length && !checkoutAttempts.length && !creditCheckouts.length
        && !entitlements.some((row)=>row.stripe_subscription_id)) {
        if (entitlements.length) await projectAccountDeletionBillingCancellation(db,{clerkUserId:owner},projectionEnv);
        return;
      }
      if ([subscriptions,entitlements,checkoutAttempts,creditCheckouts].some((rows)=>rows.length>1000)) throw new Error('Billing cleanup capacity exceeded');
      if (!options.stripeSecretKey) throw new Error('Billing cleanup configuration unavailable');
      const ids = new Set([...subscriptions.map((row) => row.stripe_subscription_id),
        ...entitlements.map((row)=>row.stripe_subscription_id).filter((id):id is string=>id!==null)]);
      if (ids.size > 1000) throw new Error('Billing cleanup capacity exceeded');
      const stripeRequest = async (path: string, method = 'GET', body?: URLSearchParams) => {
        const response = await request(`https://api.stripe.com/v1${path}`, { method, body, redirect: 'error',
          signal: AbortSignal.timeout(10_000), headers: { Authorization: `Bearer ${options.stripeSecretKey}`,
            'Content-Type': 'application/x-www-form-urlencoded' } });
        if (!response.ok) throw new Error('Billing cleanup unavailable');
        return response.json();
      };
      const sessions = [...new Set([...checkoutAttempts, ...creditCheckouts].map((row)=>row.stripe_session_id!))];
      if (sessions.length > 1000) throw new Error('Billing cleanup capacity exceeded');
      for (const session of sessions) {
        z.string().regex(/^cs_[A-Za-z0-9_]+$/).parse(session);
        const checkout = z.object({ status:z.enum(['open','complete','expired']) }).parse(await stripeRequest(`/checkout/sessions/${session}`));
        if (checkout.status==='open') await stripeRequest(`/checkout/sessions/${session}/expire`,'POST');
      }
      const customerIds = [...new Set([...customers.map((row)=>row.stripe_customer_id), ...subscriptions.map((row)=>row.stripe_customer_id)])];
      if (customerIds.length > 1000) throw new Error('Billing cleanup capacity exceeded');
      for (const customerId of customerIds) {
        let cursor: string | undefined;
        for (let page = 0; page < 10; page++) {
          const query = new URLSearchParams({ customer: customerId, status: 'all', limit: '100', ...(cursor ? { starting_after: cursor } : {}) });
          const result = z.object({ data: z.array(z.object({ id: z.string(), status: z.string() })).max(100), has_more: z.boolean() })
            .parse(await stripeRequest(`/subscriptions?${query}`));
          for (const row of result.data) if (!['canceled','incomplete_expired'].includes(row.status)) ids.add(row.id);
          if (ids.size > 1000) throw new Error('Billing cleanup capacity exceeded');
          if (!result.has_more) break;
          cursor = result.data.at(-1)?.id;
          if (!cursor || page === 9) throw new Error('Billing inventory incomplete');
        }
      }
      // Immediate cancellation, with neither a prorated invoice nor an automatic refund.
      for (const id of ids) {
        z.string().regex(/^sub_[A-Za-z0-9]+$/).parse(id);
        const live = z.object({ status: z.string() }).parse(await stripeRequest(`/subscriptions/${id}`));
        if (!['canceled','incomplete_expired'].includes(live.status)) {
          z.object({status:z.enum(['canceled','incomplete_expired'])}).parse(await stripeRequest(
            `/subscriptions/${id}`, 'DELETE', new URLSearchParams({ invoice_now: 'false', prorate: 'false' })));
        }
        await projectAccountDeletionBillingCancellation(db,{clerkUserId:owner,stripeSubscriptionId:id},projectionEnv);
      }
      await projectAccountDeletionBillingCancellation(db,{clerkUserId:owner},projectionEnv);
    },
    async vps(context) {
      const owner = context.clerkUserId;
      await assertClerkOwnershipSafe(owner,true);
      await assertDeletionOwnershipSafe(db, owner);
      const legacy = await db.executor.selectFrom('containers').select('handle').where('clerk_user_id','=',owner)
        .where('status','not in',['deleted','stopped']).limit(1).execute();
      if (legacy.length) throw new Error('Legacy runtime cleanup required');
      const machineRows = await db.executor.selectFrom('user_machines').selectAll().where('clerk_user_id','=',owner).limit(1001).execute();
      if (machineRows.length > 1000) throw new Error('Runtime cleanup capacity exceeded');
      // PostgreSQL returns BIGINT columns as strings. Normalize before calling
      // the provider or comparing the same ID from inventory and queued rows.
      const machines = machineRows.map(machine => ({ ...machine,
        hetzner_server_id: parseNullableProviderActionId(machine.hetzner_server_id),
        recovery_old_server_id: parseNullableProviderActionId(machine.recovery_old_server_id),
        recovery_create_action_id: parseNullableProviderActionId(machine.recovery_create_action_id),
      }));
      if (!machines.length) {
        await db.executor.updateTable('prebilling_provisioning_intents').set({state:'cleaned',cleaned_at:new Date().toISOString(),
          lease_expires_at:null,revision:sql`revision + 1`}).where('clerk_user_id','=',owner).execute();
        return;
      }
      if (!options.customerVpsService || !options.hetzner?.listServersByLabel) throw new Error('Runtime cleanup configuration unavailable');
      if (machines.some((machine)=>machine.recovery_encrypted_payload && !machine.recovery_create_action_id
        && !machine.hetzner_server_id)) {
        // An empty label scan cannot prove an ambiguously accepted create never reached the provider.
        throw new Error('Runtime provider create reconciliation required');
      }
      const pendingCreates = await db.executor.selectFrom('provisioning_jobs').select('provider_create_action_id')
        .where('machine_id','in',machines.map((machine)=>machine.machine_id)).where('status','not in',['completed','failed'])
        .where('provider_create_action_id','is not',null).limit(1001).execute();
      const actionIds = [...new Set([...pendingCreates.map((job)=>parseNullableProviderActionId(job.provider_create_action_id)!),
        ...machines.filter((machine)=>machine.recovery_create_action_id && !machine.hetzner_server_id)
          .map((machine)=>machine.recovery_create_action_id!)])];
      if (actionIds.length>1000) throw new Error('Runtime cleanup capacity exceeded');
      for (const actionId of actionIds) {
        if (!options.hetzner.getAction) throw new Error('Runtime create reconciliation unavailable');
        const action = await options.hetzner.getAction(actionId);
        if (!action || action.status==='running') throw new Error('Runtime provider create pending');
      }
      // Stop new jobs atomically. Leased provider creates must settle before their inventory can be trusted.
      await db.transaction(async (trx) => {
        const ids = machines.map((machine) => machine.machine_id);
        const active = await trx.executor.selectFrom('provisioning_jobs').select('job_id').where('machine_id','in',ids)
          .where('status','=','running').where('lease_expires_at','>',new Date().toISOString()).limit(1).execute();
        if (active.length) throw new Error('Provisioning cleanup pending');
        await trx.executor.updateTable('provisioning_jobs').set({ status: 'failed', encrypted_payload: null, last_error_code: 'account_deleted',
          lease_expires_at: null }).where('machine_id','in',ids).where('status','not in',['completed','failed']).execute();
        await trx.executor.updateTable('prebilling_provisioning_intents').set({ state: 'cleaned', cleaned_at: new Date().toISOString(),
          lease_expires_at: null, revision: sql`revision + 1` }).where('clerk_user_id','=',owner).execute();
      });
      for (const machine of machines) {
        if (!machine.deleted_at) {
          try { await options.customerVpsService.delete(machine.machine_id); }
          catch (error) {
            if (!(error instanceof CustomerVpsError && error.status === 404 && error.code === 'not_found')) throw error;
          }
        }
        const queued = await db.executor.selectFrom('provider_deletion_queue').select('provider_server_id')
          .where('machine_id','=',machine.machine_id).limit(1001).execute();
        if (queued.length > 1000) throw new Error('Runtime cleanup capacity exceeded');
        const serverIds = [...new Set([machine.hetzner_server_id, machine.recovery_old_server_id,
          ...queued.map((row)=>parseNullableProviderActionId(row.provider_server_id))].filter((id): id is number => id !== null))];
        const orphans = await options.hetzner.listServersByLabel(`machine_id=${machine.machine_id}`);
        if (orphans.length > 100) throw new Error('Runtime cleanup capacity exceeded');
        for (const server of orphans) {
          if (server.labels?.clerk_user_id !== owner) throw new Error('Runtime ownership mismatch');
          if (!serverIds.includes(server.id)) serverIds.push(server.id);
        }
        for (const serverId of serverIds) {
          if (await options.hetzner.getServer(serverId)) await options.hetzner.deleteServer(serverId);
          if (await options.hetzner.getServer(serverId)) throw new Error('Runtime cleanup pending');
        }
        await db.executor.updateTable('provider_deletion_queue').set({ completed_at: new Date().toISOString(), last_error: null })
          .where('machine_id','=',machine.machine_id).where('completed_at','is',null).execute();
      }
    },
    async integrations(context) {
      const owner = context.clerkUserId;
      const users = await db.executor.selectFrom('users').select(['id','pipedream_external_id']).where('clerk_id','=',owner).execute();
      const servicesPresent=await hasTable(db,'connected_services');
      if(!servicesPresent && users.some((user)=>user.pipedream_external_id)) throw new Error('Integration inventory unavailable');
      if (servicesPresent) {
        for (const user of users) {
          const services = await sql<{ id: string; pipedream_account_id: string }>`SELECT id, pipedream_account_id FROM connected_services
            WHERE user_id = ${user.id} AND (status <> 'revoked' OR left(pipedream_account_id,6) = 'gmail_') LIMIT 1001`.execute(db.executor);
          if (services.rows.length > 1000) throw new Error('Integration cleanup capacity exceeded');
          const native = services.rows.filter(row => row.pipedream_account_id.startsWith('gmail_'));
          if (native.length && !options.nativeGmail) throw new Error('Gmail cleanup configuration unavailable');
          for (const row of native) {
            if (!await options.nativeGmail!.revoke({ userId: user.id, connectionId: row.id })) throw new Error('Gmail cleanup unavailable');
          }
          if ((services.rows.length !== native.length || user.pipedream_external_id) && !options.pipedream) throw new Error('Integration cleanup configuration unavailable');
          if (options.pipedream) {
            const accounts = await options.pipedream.listAccounts(user.pipedream_external_id ?? user.id);
            if (accounts.length > 1000) throw new Error('Integration cleanup capacity exceeded');
            const ids = [...new Set(accounts.map((account) => account.id))];
            if (ids.length > 1000) throw new Error('Integration cleanup capacity exceeded');
            for (const id of ids) await options.pipedream.revokeAccount(id);
            await sql`UPDATE connected_services SET status='revoked' WHERE user_id=${user.id}`.execute(db.executor);
          }
        }
      }
      if (await hasTable(db,'custom_mcp_servers')) {
        const liveMachine = await db.executor.selectFrom('user_machines').select('machine_id')
          .where('clerk_user_id','=',owner).where('deleted_at','is',null).executeTakeFirst();
        if (liveMachine) throw new Error('Integration runtime cleanup pending');
        for (const user of users) {
          const servers = await sql<{id:string}>`SELECT id FROM custom_mcp_servers WHERE user_id=${user.id} LIMIT 1001`.execute(db.executor);
          if (servers.rows.length > 1000) throw new Error('Integration cleanup capacity exceeded');
          if (servers.rows.length && !options.customMcp) throw new Error('Integration cleanup configuration unavailable');
          for (const server of servers.rows) await options.customMcp!.remove(user.id,server.id);
        }
      }
      await revokeOwnerMatrixCredentials(db,owner,options.matrixHomeserverUrl,request);
      await revokeWhatsApp(db, owner);
      await revokeVoiceNumbers(options, owner, request);
    },
    async prepareAppleRevocation(context) {
      if (context.appleRevocationPrepared) return context;
      if (context.appleRevocationUnknown) {
        // The Clerk identity is gone, so opaque access tokens cannot be refreshed.
        // Apple TN3194 explicitly permits manual revocation while deletion proceeds.
        return { ...context, appleTokens: context.appleTokens.filter((token) => token.tokenType === 'refresh_token'),
          manualAppleRevocationRequired: true, appleRevocationPrepared: true };
      }
      if (!context.appleTokens.length) return { ...context, appleRevocationPrepared: true };
      if (!options.apple) throw new Error('Apple revocation configuration unavailable');
      await assertAppleDeletionConfig(options.apple);
      const refreshTokens=context.appleTokens.filter((token)=>token.tokenType==='refresh_token');
      const accessTokens=context.appleTokens.filter((token)=>token.tokenType==='access_token'
        && !refreshTokens.some((refresh)=>refresh.clientId===token.clientId));
      let currentAccessTokens: AccountDeletionContext['appleTokens']=[];
      let manualRequired = context.manualAppleRevocationRequired === true;
      if (accessTokens.length) {
        const userValue = await clerk(`/users/${encodeURIComponent(context.clerkUserId)}`, 'GET', true);
        if (userValue === null) {
          return { ...context, appleTokens: refreshTokens, manualAppleRevocationRequired: true, appleRevocationPrepared: true };
        }
        const user=userSchema.parse(userValue);
        const current=await clerk(`/users/${encodeURIComponent(context.clerkUserId)}/oauth_access_tokens/oauth_apple`);
        const prepared = await prepareClerkAppleRevocation(current, user.private_metadata.matrix_apple_token_client_ids ?? {}, options.apple, request);
        currentAccessTokens = prepared.tokens;
        manualRequired ||= prepared.manualRevocationRequired || accessTokens.some((old) =>
          !currentAccessTokens.some((current) => current.clientId === old.clientId));
      }
      return { ...context, appleRevocationPrepared: true, appleTokens: [...refreshTokens, ...currentAccessTokens],
        ...(manualRequired ? { manualAppleRevocationRequired: true } : {}) };
    },
    async apple(context) {
      if (context.appleRevocationUnknown && !context.manualAppleRevocationRequired) throw new Error('Apple revocation preparation required');
      if (context.appleTokens.some((token)=>token.tokenType==='access_token') && !context.appleRevocationPrepared) {
        throw new Error('Apple revocation preparation required');
      }
      if (!context.appleTokens.length) return;
      if (!options.apple) throw new Error('Apple revocation configuration unavailable');
      // The job durably captures this exact grant before the remote side effect, so a retry needs no Clerk grant.
      await createAppleRevoker(options.apple, request)(context.appleTokens);
    },
    async storage(context) {
      const machines = await db.executor.selectFrom('user_machines').select('deleted_at')
        .where('clerk_user_id','=',context.clerkUserId).limit(1001).execute();
      if (machines.length > 1000 || machines.some((machine) => !machine.deleted_at ||
        !Number.isFinite(Date.parse(machine.deleted_at)) || Date.parse(machine.deleted_at) + 86_400_000 > Date.now())) {
        throw new Error('Storage upload expiration pending');
      }
      if (!options.objectStore) throw new Error('Storage cleanup configuration unavailable');
      await eraseOwnerStorage(options.objectStore, context.clerkUserId, options.r2PrefixRoot);
    },
    async data(context) { await eraseOwnerPlatformData(db, context.clerkUserId, options.ownerHash); },
    async clerk(context) {
      await assertClerkOwnershipSafe(context.clerkUserId,true);
      await clerk(`/users/${encodeURIComponent(context.clerkUserId)}`, 'DELETE', true);
    },
  };
}
async function revokeWhatsApp(db: PlatformDB, owner: string): Promise<void> {
  if (!await hasTable(db,'whatsapp_connections')) return;
  await db.transaction(async (trx) => {
    // Share the repository's mutation fence so sender ownership cannot change
    // between locating the connection/challenge and removing its queued jobs.
    await sql`SELECT pg_advisory_xact_lock(5460001)`.execute(trx.executor);
    // Payloads are encrypted text. Current connections uniquely bind senders;
    // challenge hashes bind exact verification/confirmation job IDs even when
    // linking never finished or that sender now belongs to another account.
    await sql`DELETE FROM whatsapp_jobs WHERE sender IN (SELECT sender FROM whatsapp_connections WHERE owner=${owner})
      OR id IN (SELECT 'verification:' || token_hash FROM whatsapp_link_challenges WHERE owner=${owner}
        UNION ALL SELECT 'connected:' || token_hash FROM whatsapp_link_challenges WHERE owner=${owner})`.execute(trx.executor);
    await sql`DELETE FROM whatsapp_link_challenges WHERE owner=${owner}`.execute(trx.executor);
    await sql`DELETE FROM whatsapp_connections WHERE owner=${owner}`.execute(trx.executor);
  });
}
async function revokeVoiceNumbers(options: AccountDeletionAdapterOptions, owner: string, request: typeof fetch) {
  if (!options.twilio) return; // No owner-managed voice resources exist without the configured account.
  const handles = await sql<{handle:string}>`${ownerHandlesQuery(owner)} LIMIT 1001`.execute(options.db.executor);
  if (handles.rows.length > 1000) throw new Error('Voice cleanup capacity exceeded');
  const config = options.twilio;
  z.string().regex(/^AC[0-9a-f]{32}$/i).parse(config.accountSid);
  const base = `https://api.twilio.com/2010-04-01/Accounts/${config.accountSid}/IncomingPhoneNumbers`;
  const auth = { Authorization: `Basic ${Buffer.from(`${config.accountSid}:${config.authToken}`).toString('base64')}` };
  let path = `${base}.json?PageSize=1000`;
  for (let page=0; page<100; page++) {
    const response = await request(path, { headers: auth, redirect:'error', signal:AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error('Voice cleanup unavailable');
    const numbers = z.object({ incoming_phone_numbers:z.array(z.object({sid:z.string().regex(/^PN[0-9a-f]{32}$/i),voice_url:z.string()})).max(1000),
      next_page_uri:z.string().nullable() }).parse(await response.json());
    for (const number of numbers.incoming_phone_numbers) {
      let url: URL;
      try { url = new URL(number.voice_url); } catch (error) { if (error instanceof TypeError) continue; throw error; }
      if (url.origin !== new URL(config.publicBaseUrl).origin || url.pathname !== '/voice/webhook/twilio'
        || !handles.rows.some((row)=>row.handle===url.searchParams.get('handle'))) continue;
      const removed = await request(`${base}/${number.sid}.json`, { method:'DELETE', headers:auth, redirect:'error', signal:AbortSignal.timeout(10_000) });
      if (!removed.ok && removed.status!==404) throw new Error('Voice cleanup unavailable');
      await removed.body?.cancel();
    }
    if (!numbers.next_page_uri) return;
    const next = new URL(numbers.next_page_uri,'https://api.twilio.com');
    if (next.origin !== 'https://api.twilio.com' || !next.pathname.startsWith(`/2010-04-01/Accounts/${config.accountSid}/IncomingPhoneNumbers`)) throw new Error('Voice inventory invalid');
    path=next.toString();
  }
  throw new Error('Voice inventory capacity exceeded');
}
