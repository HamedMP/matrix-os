import { botExecutionPresentation } from '@matrix-os/contracts';
import type { BotAuthorityView, BotTaskSummary, CanonicalChatModelSelection, CanonicalProviderCatalog, ChatAgent } from '@matrix-os/contracts';
import { deriveCanonicalProviderChoices } from '../../canonical-provider-choice.js';
import { AgentAvatar } from '../AgentAvatar.js';
import { chatAgentButtonClass, chatAgentMutedStyle } from '../theme.js';
import { AgentModelField } from '../AgentEditor.js';
import { MatrixBotModelField } from './MatrixBotModelField.js';
import { BotTaskStatus } from "./BotTaskStatus.js";
import { BotAuthorityPanel } from './BotAuthorityPanel.js';
import type { BotClient } from './client.js';

export function BotDetailsPanel({ agent, agentId, authority, bots, catalog, catalogLoading, pending, onModelChange, onClose, onChanged, onEdit, tasks = [], onSetup, onRefreshCatalog, hosted = false }: {
  tasks?: readonly BotTaskSummary[]; onSetup?: () => void; onRefreshCatalog?: () => void;
  hosted?: boolean; agent: ChatAgent | null; agentId:string; authority: BotAuthorityView | null; bots: BotClient; catalog?: CanonicalProviderCatalog | null; catalogLoading?: boolean;
  pending: boolean; onModelChange(selection: CanonicalChatModelSelection): void; onClose(): void; onChanged(): void; onEdit(): void;
}) {
  const models = catalog ? deriveCanonicalProviderChoices(catalog) : [];
  const modelDetails = <section className='grid gap-2'><h4 className='text-xs font-semibold'>Runs on</h4><p className='text-xs' style={chatAgentMutedStyle}>{agent ? botExecutionPresentation(agent, catalog).modelLabel : "Checking bot model…"}</p>
      {agent && !agent.recipeRef ? <AgentModelField id={`custom-bot-model-${agentId}`} selected={agent.selection} pending={pending || Boolean(catalogLoading) || !catalog} models={models} hermesOnly={Boolean(agent.recipe?.skills.includes("matrix-jev-email-triage"))} onSetup={onSetup} change={value => { if (value.selection) onModelChange(value.selection); }}/> : agent ? <MatrixBotModelField label='Bot model' selection={agent.selection} models={models} catalog={catalog} catalogLoading={catalogLoading} pending={pending || !catalog} onSetup={onSetup} onRefreshCatalog={onRefreshCatalog} onChange={onModelChange}/> : <p role="status" className="text-xs" style={chatAgentMutedStyle}>Bot model is unavailable. <button type="button" className={chatAgentButtonClass} onClick={onChanged}>Retry bot details</button></p>}
      <p className='text-xs leading-5' style={chatAgentMutedStyle}>Automatic uses the route configured on this computer. Matrix AI models use Matrix AI credit. App access still requires the bot’s permission.</p>
    </section>;
  return <aside aria-label='Bot details' className={`matrix-bot-details${hosted ? ' matrix-bot-details--hosted' : ''}`}>
    <header className='flex items-start gap-3'>
      <AgentAvatar id={agentId} name={agent?.name ?? "Your bot"} size='small'/>
      <div className='min-w-0 flex-1'><h3 className='truncate text-sm font-semibold'>{agent?.name ?? "Your bot"}</h3><p className='mt-1 text-xs' style={chatAgentMutedStyle}>{agent?.description || 'Persistent bot conversation'}</p></div>
      <button type='button' aria-label='Close bot details' className={chatAgentButtonClass} onClick={onClose}>×</button>
    </header>
    <section className='grid gap-2'><div className='flex items-center justify-between'><h4 className='text-xs font-semibold'>Instructions</h4><button type='button' className='text-xs underline underline-offset-2' disabled={!agent} onClick={onEdit}>Edit bot</button></div><p className='whitespace-pre-wrap text-sm leading-6'>{agent?.instructions ?? "Bot instructions are unavailable."}</p></section>
    {tasks.length ? <details className="text-xs"><summary className="cursor-pointer font-semibold">Task history</summary><ul className="mt-2 grid gap-2">{tasks.map(task => <li key={task.taskId}><BotTaskStatus task={task}/><time className="text-xs" style={chatAgentMutedStyle} dateTime={task.updatedAt}>{new Date(task.updatedAt).toLocaleString()}</time></li>)}</ul></details> : null}
    {agent && !agent.recipeRef ? <><p className='text-xs' style={chatAgentMutedStyle}>This bot uses its saved runtime and request permissions. Recipe task, app access and memory controls are unavailable for this bot.</p>{modelDetails}</> : authority ? <BotAuthorityPanel compact title="Apps" beforeMemory={modelDetails} view={authority} onRevoke={grantId=>bots.revoke(agentId,grantId)} onMemory={(itemId, action, input)=>bots.memory(agentId,itemId,action,input)} onChanged={onChanged}/> : <><p role='status' className='text-xs' style={chatAgentMutedStyle}>Loading access and memory…</p>{modelDetails}</>}
  </aside>;
}
