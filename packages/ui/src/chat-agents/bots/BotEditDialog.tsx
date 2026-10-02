import type { CanonicalProviderCatalog, ChatAgent } from '@matrix-os/contracts';
import { useEffect, useRef, useState } from 'react';
import { Dialog } from '../../Dialog.js';
import { deriveCanonicalProviderChoices } from '../../canonical-provider-choice.js';
import { AgentEditor, type AgentDraft } from '../AgentEditor.js';
import { AgentAvatar } from '../AgentAvatar.js';
import { chatAgentSurfaceStyle } from '../theme.js';
import type { ChatAgentClient } from '../client.js';

export function BotEditDialog({ agent, client, catalog, catalogLoading, onClose, onSaved }: {
  agent: ChatAgent; client: ChatAgentClient; catalog?: CanonicalProviderCatalog | null; catalogLoading?: boolean;
  onClose(): void; onSaved(agent: ChatAgent): void;
}) {
  const owner = useRef({ client, agentId: agent.id, mounted: true });
  owner.current.client = client; owner.current.agentId = agent.id;
  useEffect(() => { owner.current.mounted = true; return () => { owner.current.mounted = false; }; }, []);
  const [draft, setDraft] = useState<AgentDraft>({ name: agent.name, description: agent.description, instructions: agent.instructions, selection: agent.selection, requestId:'edit' });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const save = async () => {
    if (pending || (catalogLoading && JSON.stringify(draft.selection) !== JSON.stringify(agent.selection))) return;
    const isCurrent = () => owner.current.mounted && owner.current.client === client && owner.current.agentId === agent.id;
    setPending(true); setError('');
    try {
      const updated = await client.update(agent.id, { name: draft.name.trim(), description:draft.description, instructions:draft.instructions,
        ...(draft.selection && JSON.stringify(draft.selection) !== JSON.stringify(agent.selection) ? { selection:draft.selection } : {}), baseRevision:agent.revision });
      if (isCurrent()) { onSaved(updated); onClose(); }
    } catch (failure: unknown) {
      console.warn('[bots] Edit unavailable:', failure instanceof Error ? failure.name : 'UnknownError');
      if (isCurrent()) setError('Could not save this bot. Refresh and try again.');
    } finally { if (isCurrent()) setPending(false); }
  };
  return <Dialog open aria-label='Edit bot' onClose={()=>{ if(!pending) onClose(); }} style={{...chatAgentSurfaceStyle, width:'min(92vw,480px)', maxHeight:'85vh', overflowY:'auto'}}>
    <header className='flex items-center gap-3'><AgentAvatar id={agent.id} name={agent.name}/><div><h2 className='text-base font-semibold'>Edit bot</h2><p className='text-xs'>{agent.name}</p></div></header>
    <AgentEditor draft={draft} editing={agent} pending={pending} models={catalog ? deriveCanonicalProviderChoices(catalog):[]} catalog={catalog} catalogLoading={catalogLoading} recipeCatalog={null} connections={[]} recipeLoading={false} recipeError='' connectionError='' change={value=>setDraft(current=>({...current,...value}))} onSave={save} onArchive={async()=>{}} onBack={onClose} onRetryRecipe={()=>{}} allowArchive={false}/>
    {error ? <p role='alert' className='mt-3 text-xs'>{error}</p>:null}
  </Dialog>;
}
