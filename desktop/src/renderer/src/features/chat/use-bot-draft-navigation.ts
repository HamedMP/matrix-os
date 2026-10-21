import { useBotDraftRecovery, useBotMentionNavigation, BOT_ATTACHMENT_HANDOFF_REASON, type ChatAgentClient } from '@matrix-os/ui';
import { useConnection } from '../../stores/connection';
import { desktopProviderIdentityKey } from '../../lib/provider-settings-identity';

/** Restores the retained original draft without calling the intentional New chat reset. */
export function useBotDraftNavigation({ client, scope, revision, chatId, projectId, sourceHasAttachments, seed, open, restoreNewDraft }: {
  client?:ChatAgentClient;scope:string;revision:number;chatId?:string|null;projectId:string|null;sourceHasAttachments:boolean;
  seed(chatId:string,text:string):boolean;open(chatId:string):void;restoreNewDraft():void;
}) {
  const identityKey=`${useConnection(desktopProviderIdentityKey)}|${projectId ?? "global"}`;
  const recovery=useBotDraftRecovery({client,identityKey,scope,targetScope:id=>`chat:${id}`,seed,open,
    capture:()=>({scope,projectId,chatId:scope.startsWith('chat:') ? chatId:null}),
    restore:source=>{if(source.chatId)open(source.chatId);else restoreNewDraft();},
  });
  const mention=useBotMentionNavigation(client,`${scope}:${revision}`,recovery.openBotMention,sourceHasAttachments ? BOT_ATTACHMENT_HANDOFF_REASON:undefined);
  return {...mention,...recovery};
}
