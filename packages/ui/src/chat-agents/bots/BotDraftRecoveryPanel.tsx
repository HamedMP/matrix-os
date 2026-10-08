import { chatAgentButtonClass, chatAgentMutedStyle } from '../theme.js';
export function BotDraftRecoveryPanel({ onReturn }: {onReturn():void}) {
  return <section aria-label="Draft handoff recovery" className="mx-auto my-2 flex max-w-[720px] flex-wrap items-center gap-2 px-3 text-xs" style={chatAgentMutedStyle}>
    <p role="status">This bot already has a draft. Your original text draft is preserved.</p>
    <button type="button" className={chatAgentButtonClass} onClick={onReturn}>Return to original draft</button>
  </section>;
}
