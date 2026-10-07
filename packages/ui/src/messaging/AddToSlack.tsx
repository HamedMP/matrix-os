import type { CSSProperties } from 'react';
import { SLACK_INSTALL_URL } from '@matrix-os/contracts/slack-bridge';

const style: CSSProperties = {display:'inline-flex',alignItems:'center',justifyContent:'center',gap:10,minHeight:44,padding:'10px 18px',border:'1px solid var(--matrix-border)',borderRadius:'var(--matrix-radius-md, 10px)',background:'var(--matrix-card)',color:'var(--matrix-fg)',fontWeight:600,textDecoration:'none',fontSize:14,maxWidth:'100%',cursor:'pointer'};
export function SlackMark() {
  return <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
    <rect x="10" y="1" width="4" height="9" rx="2"/><rect x="15" y="10" width="9" height="4" rx="2"/>
    <rect x="10" y="15" width="4" height="9" rx="2"/><rect x="1" y="10" width="9" height="4" rx="2"/>
    <rect x="5" y="5" width="4" height="4" rx="2"/><rect x="15" y="5" width="4" height="4" rx="2"/>
    <rect x="15" y="15" width="4" height="4" rx="2"/><rect x="5" y="15" width="4" height="4" rx="2"/>
  </svg>;
}
/** Every install entry goes through Matrix; never a stateless Slack share URL. */
export function AddToSlack({onClick,onOpen,busy=false,disabled=false}:{onClick?:()=>void;onOpen?:()=>void;busy?:boolean;disabled?:boolean}) {
  const contents=<><SlackMark />{busy ? 'Opening Slack…' : 'Add to Slack'}</>;
  if(onClick) return <button type="button" onClick={onClick} disabled={disabled || busy} aria-busy={busy} style={{...style,...(disabled || busy ? {opacity:0.6,cursor:'not-allowed'} : {})}}>{contents}</button>;
  return <a href={SLACK_INSTALL_URL} onClick={onOpen ? event=>{event.preventDefault();onOpen();} : undefined} target="_blank" rel="noopener noreferrer" style={style}>{contents}</a>;
}
