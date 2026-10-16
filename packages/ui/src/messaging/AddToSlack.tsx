import type { CSSProperties } from 'react';
import { messagingPlatformUrl } from '@matrix-os/contracts';

const style: CSSProperties = {display:'inline-flex',alignItems:'center',justifyContent:'center',gap:10,minHeight:44,padding:'10px 18px',border:'1px solid var(--matrix-border, var(--border-subtle, var(--border)))',borderRadius:'var(--matrix-radius-md, 10px)',background:'var(--matrix-card, var(--bg-surface, var(--card)))',color:'var(--matrix-fg, var(--text-primary, var(--foreground)))',fontWeight:600,textDecoration:'none',fontSize:14,maxWidth:'100%',cursor:'pointer'};
export function SlackMark() {
  return <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
    <rect x="10" y="1" width="4" height="9" rx="2"/><rect x="15" y="10" width="9" height="4" rx="2"/>
    <rect x="10" y="15" width="4" height="9" rx="2"/><rect x="1" y="10" width="9" height="4" rx="2"/>
    <rect x="5" y="5" width="4" height="4" rx="2"/><rect x="15" y="5" width="4" height="4" rx="2"/>
    <rect x="15" y="15" width="4" height="4" rx="2"/><rect x="5" y="15" width="4" height="4" rx="2"/>
  </svg>;
}
/** Every install entry goes through Matrix; never a stateless Slack share URL. */
export function AddToSlack({onClick,onOpen,busy=false,disabled=false,platformOrigin,allowDevelopmentOrigin=false}:{onClick?:()=>void;onOpen?:(url:string)=>void;busy?:boolean;disabled?:boolean;platformOrigin?:string|null;allowDevelopmentOrigin?:boolean}) {
  const url=messagingPlatformUrl('/slack/install',platformOrigin,allowDevelopmentOrigin);
  const contents=<><SlackMark />{busy ? 'Opening Slack…' : 'Add to Slack'}</>;
  if(!url) return <button type="button" disabled style={style}>Add to Slack</button>;
  if(onClick) return <button type="button" onClick={onClick} disabled={disabled || busy} aria-busy={busy} style={{...style,...(disabled || busy ? {opacity:0.6,cursor:'not-allowed'} : {})}}>{contents}</button>;
  return <a href={url} onClick={onOpen ? event=>{event.preventDefault();onOpen(url);} : undefined} target="_blank" rel="noopener noreferrer" style={style}>{contents}</a>;
}
