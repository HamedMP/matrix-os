import type { DriveConnection, PreviewDriveIntegration } from './preview-drive-routes.js';

interface OwnerConnectionStore {
  listConnectedServices(userId: string): Promise<DriveConnection[]>;
  getUserById(userId: string): Promise<{ pipedream_external_id?: string | null } | null>;
  touchServiceUsage(connectionId: string): Promise<void>;
}

/** Resolve the admitted actor's exact connection again at provider dispatch.
 * A label is browser intent, never authority to select a replacement account. */
export function createPreviewDriveIntegration(options: {
  db: OwnerConnectionStore;
  resolveUserId(actorId: string): Promise<string | null>;
  pipedream: unknown;
  getService(serviceId: string): unknown;
  getAction(serviceId: string, actionId: string): { risk: string } | null | undefined;
  executeAction(input: { pipedream: unknown; externalUserId: string;
    connection: DriveConnection; def: unknown; actionDef: { risk: string };
    serviceId: string; actionId: string; params: Record<string, unknown> }): Promise<{ data: unknown }>;
}): PreviewDriveIntegration {
  return {
    async listConnections(actorId) {
      const userId = await options.resolveUserId(actorId);
      if (!userId) return [];
      return (await options.db.listConnectedServices(userId))
        .filter(row => row.service === 'google_drive' && row.status === 'active');
    },
    async execute(actorId, binding, params) {
      const userId = await options.resolveUserId(actorId);
      if (!userId) throw new Error('Preview Drive account unavailable');
      const selected = (await options.db.listConnectedServices(userId)).filter(row =>
        row.id === binding.connectionId && row.pipedream_account_id === binding.providerAccountId
        && row.service === 'google_drive' && row.status === 'active' && row.account_label === binding.label);
      if (selected.length !== 1) throw new Error('Preview Drive account unavailable');
      const user = await options.db.getUserById(userId);
      if (!user?.pipedream_external_id) throw new Error('Preview Drive account unavailable');
      const def = options.getService('google_drive');
      const actionDef = options.getAction('google_drive', 'list_files');
      if (!def || !actionDef || actionDef.risk !== 'read') throw new Error('Preview Drive action unavailable');
      const result = await options.executeAction({ pipedream: options.pipedream, externalUserId: user.pipedream_external_id,
        connection: selected[0]!, def, actionDef, serviceId: 'google_drive', actionId: 'list_files', params });
      await options.db.touchServiceUsage(selected[0]!.id);
      return result.data;
    },
  };
}
