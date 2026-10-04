import type { BotRecipeSummary, CanonicalChatModelSelection, CanonicalProviderCatalog } from '@matrix-os/contracts';
import { useState } from 'react';
import { Dialog } from '../../Dialog.js';
import type { CanonicalProviderChoice } from '../../canonical-provider-choice.js';
import { AgentAvatar } from '../AgentAvatar.js';
import { chatAgentButtonClass, chatAgentPrimaryButtonClass, chatAgentInputClass, chatAgentMutedStyle, chatAgentSurfaceStyle } from '../theme.js';
import { MatrixBotModelField } from './MatrixBotModelField.js';

export function BotRecipeSetup({ recipe, pending, createDisabled, error, selection, models, catalog, catalogLoading, onSelectionChange, onCreate, onClose }: {
  recipe: BotRecipeSummary; pending: boolean; createDisabled?: boolean; error: string; selection: CanonicalChatModelSelection | null;
  models: readonly CanonicalProviderChoice[]; catalog?: CanonicalProviderCatalog | null; catalogLoading?: boolean;
  onSelectionChange(selection: CanonicalChatModelSelection): void;
  onCreate(name: string): void; onClose(): void;
}) {
  const [name, setName] = useState(recipe.name);
  return <Dialog open onClose={() => { if (!pending) onClose(); }} aria-label={`Set up ${recipe.name}`} className="matrix-agent-edit-dialog" style={{ ...chatAgentSurfaceStyle, width:'min(92vw,420px)' }}>
    <header className='flex items-start gap-3'><AgentAvatar id={recipe.recipeId} name={recipe.name} size="small"/><div className='min-w-0 flex-1'><h2 className='text-base font-semibold'>{recipe.name}</h2><p className='mt-1 text-xs' style={chatAgentMutedStyle}>{recipe.description}</p></div><button type='button' aria-label='Close bot setup' disabled={pending} className={chatAgentButtonClass} onClick={onClose}>×</button></header>
    <form className='mt-5 grid gap-4' onSubmit={event=>{event.preventDefault(); if(!pending && !createDisabled && selection && name.trim()) onCreate(name.trim());}}>
      <label className='grid gap-1.5 text-sm'>Name<input className={chatAgentInputClass} value={name} maxLength={80} required disabled={pending} onChange={event=>setName(event.target.value)}/></label>
      <section className='grid gap-1 text-xs'><h3 className='font-semibold'>Apps</h3><p style={chatAgentMutedStyle}>App connections and permissions are requested in the bot’s Chat when needed.</p></section>
      <MatrixBotModelField label='Bot model' selection={selection} models={models} catalog={catalog} catalogLoading={catalogLoading} pending={pending} requireSelection onChange={onSelectionChange}/>
      <div className='grid gap-1 text-xs'><span style={chatAgentMutedStyle}>Runs</span><span>When you ask</span></div>
      {error ? <p role='alert' className='text-xs'>{error}</p> : null}
      <div className='flex justify-between gap-2'><button type='submit' className={chatAgentPrimaryButtonClass} disabled={pending || createDisabled || !selection || !name.trim()}>{pending ? 'Creating…' : 'Create bot'}</button><button type='button' className={chatAgentButtonClass} disabled={pending} onClick={onClose}>Cancel</button></div>
    </form>
  </Dialog>;
}
