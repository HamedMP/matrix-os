import { z } from 'zod/v4';
import { createDevstackCliRoutes } from './devstack-cli-routes.js';
import { createDevstackPublicPreviewAccess } from './devstack-public-preview.js';
import { createDevstackPublisherClient } from './devstack-publisher-client.js';
import { devstackApprovalOrigin } from './devstack-approval-origin.js';
import { createDevstackApprovalAuth } from './devstack-approval-auth.js';
import type { ClerkAuth } from './clerk-auth.js';
import type { DevstackRunStore } from './devstack-runs/store.js';
import { createDevstackSourceRuns } from './devstack-source-runs.js';

type PreviewDeps = Parameters<typeof createDevstackPublicPreviewAccess>[0] & { approvalClerkAuth?: ClerkAuth };
const publisherConfig = z.strictObject({
  socketPath: z.string().min(1).max(100), identity: z.string().length(64).regex(/^[a-f0-9]+$/),
  approvalOrigin: z.string().min(1).max(256),
});

/** Kept separate from ordinary runtime/Stage 2 startup. Disabled by default. */
export function createDevstackHostedAccess(deps: PreviewDeps | undefined, env: NodeJS.ProcessEnv, store?: DevstackRunStore) {
  const raw = env.MATRIX_DEVSTACK_SOURCE_PUBLISHER;
  const worktree = env.MATRIX_DEVSTACK_CLI_PILOT_WORKTREE;
  const enabled = deps?.config.publicBrowserOnly && worktree
    && deps.config.targets.some(target => target.worktree === worktree);
  if (raw && !enabled) throw new Error('DevStack source publisher requires an enrolled public pilot worktree.');
  const config = raw ? publisherConfig.parse(JSON.parse(raw)) : undefined;
  const approvalOrigin = config && devstackApprovalOrigin(config.approvalOrigin, deps!.config.previewOrigin);
  const source = config && createDevstackPublisherClient(config);
  const sourceRuns = source && store && createDevstackSourceRuns({ store, origin: deps!.config.previewOrigin, publish: source.apply });
  const approvalClerkAuth = approvalOrigin && (deps!.approvalClerkAuth
    ?? createDevstackApprovalAuth(env, approvalOrigin, deps!.config.issuer));
  const cli = enabled ? createDevstackCliRoutes({ ...deps, enabledWorktrees: new Set([worktree]), approvalOrigin, source, sourceRuns,
    approvalClerkAuth: approvalClerkAuth || undefined }) : undefined;
  const preview = deps?.config.publicBrowserOnly ? createDevstackPublicPreviewAccess({ ...deps,
    cliPairingEnabled: Boolean(cli), cliSourceEnabled: Boolean(source), cliSourceRunsEnabled: Boolean(sourceRuns), approvalOrigin,
  }) : undefined;
  return { devstackCliRoutes: cli, devstackPublicPreview: preview, close: async () => { await sourceRuns?.close(); } };
}
