import { useState } from 'react';
import { AddToSlack, SlackMark } from './AddToSlack.js';

export function SlackInstallPanel({onInstall}:{onInstall?:()=>void | Promise<void>}) {
  const [error,setError]=useState(false);
  const open=async()=>{try {setError(false);await onInstall?.();} catch (error:unknown) {
    console.warn('[messaging] browser unavailable',error instanceof Error ? error.name : 'UnknownError');setError(true);
  }};
  return <section aria-label="Messaging" style={{maxWidth:640,color:'var(--matrix-fg, var(--text-primary, var(--foreground)))'}}>
    <h2 style={{fontSize:20,fontWeight:600,marginBottom:8}}>Messaging</h2>
    <p style={{color:'var(--matrix-muted-fg, var(--text-secondary, var(--muted-foreground)))',lineHeight:1.6,marginBottom:24}}>Talk to your Matrix assistant from the apps you already use.</p>
    <div style={{border:'1px solid var(--matrix-border, var(--border-subtle, var(--border)))',borderRadius:'var(--matrix-radius-lg, 14px)',padding:24}}>
      <h3 style={{display:'flex',alignItems:'center',gap:10,fontSize:17,fontWeight:600}}><SlackMark />Slack</h3>
      <p style={{lineHeight:1.6,margin:'12px 0 20px'}}>Message your personal assistant privately, or ask your company assistant in a connected channel.</p>
      <AddToSlack onOpen={onInstall ? ()=>void open() : undefined} />
      {error && <p role="alert">Unable to open installation. Try again.</p>}
      <ol style={{paddingLeft:20,lineHeight:1.7,marginTop:20}}>
        <li>Sign in to Matrix and choose your organization. An administrator installs the app.</li>
        <li>In Slack, send <strong>connect</strong> to Matrix to link your personal assistant.</li>
        <li>Return to Slack and say hi. Your Matrix computer and AI access must be ready.</li>
      </ol>
      <p style={{fontSize:13,lineHeight:1.6,marginTop:16,color:'var(--matrix-muted-fg, var(--text-secondary, var(--muted-foreground)))'}}>An existing installation? Start at step 2. Company channels are connected separately by your administrator.</p>
      <a href="https://matrix-os.com/docs/slack-company-brain" target="_blank" rel="noopener noreferrer" style={{display:'inline-block',marginTop:16,color:'inherit',textUnderlineOffset:4}}>Slack connection guide →</a>
    </div>
  </section>;
}
