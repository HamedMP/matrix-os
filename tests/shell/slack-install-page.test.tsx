// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const state=vi.hoisted(()=>({loaded:true,signedIn:true,userId:'user_first',sessionId:'session_first',org:{id:'org_team',name:'Team'},getToken:vi.fn(),start:vi.fn()}));
vi.mock('@clerk/nextjs',()=>({useAuth:()=>({isLoaded:state.loaded,isSignedIn:state.signedIn,userId:state.userId,sessionId:state.sessionId,getToken:state.getToken}),useOrganization:()=>({isLoaded:state.loaded,organization:state.org}),OrganizationSwitcher:()=> <span>Choose organization</span>,SignIn:()=> <span>Sign in</span>}));
vi.mock('../../shell/src/lib/slack-install',()=>({startSlackInstallation:state.start}));
import { SlackInstallation } from '../../shell/src/components/auth/SlackInstallation';
afterEach(cleanup);
beforeEach(()=>{state.loaded=true;state.signedIn=true;state.userId='user_first';state.sessionId='session_first';state.org={id:'org_team',name:'Team'};state.start.mockReset();});
describe('Slack installation page',()=>{
  it('requires sign-in before organization installation',()=>{
    state.signedIn=false;render(<SlackInstallation />);expect(screen.getByText('Sign in')).toBeTruthy();expect(screen.queryByRole('button',{name:'Add to Slack'})).toBeNull();
  });
  it('selects an organization and contains unavailable or administrator errors',async()=>{
    state.start.mockResolvedValue({status:'forbidden'});render(<SlackInstallation />);
    fireEvent.click(screen.getByRole('button',{name:'Add to Slack'}));
    await waitFor(()=>expect(screen.getByRole('alert').textContent).toContain('administrator'));
    expect(state.start).toHaveBeenCalledWith('org_team',window.location.origin,state.getToken);
    expect(screen.getByText('Choose organization')).toBeTruthy();
  });
  it('does not inherit a pending installation result after an account switch',async()=>{
    let settle!: (value: {status:'forbidden'})=>void;
    state.start.mockImplementation(()=>new Promise(resolve=>{settle=resolve;}));
    const view=render(<SlackInstallation />);fireEvent.click(screen.getByRole('button',{name:'Add to Slack'}));
    state.userId='user_second';state.sessionId='session_second';view.rerender(<SlackInstallation />);
    settle({status:'forbidden'});
    await waitFor(()=>expect(screen.getByRole('button',{name:'Add to Slack'}).hasAttribute('disabled')).toBe(false));
    expect(screen.queryByRole('alert')).toBeNull();
  });
  it('never shows success just because installation was started',async()=>{
    state.start.mockResolvedValue({status:'unavailable'});render(<SlackInstallation />);
    fireEvent.click(screen.getByRole('button',{name:'Add to Slack'}));
    await waitFor(()=>expect(screen.getByRole('alert').textContent).toContain('try again'));
    expect(screen.queryByText('Slack connected')).toBeNull();
  });
});
