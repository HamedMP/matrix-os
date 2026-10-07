// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const state=vi.hoisted(()=>({loaded:true,signedIn:true,org:{id:'org_team',name:'Team'},getToken:vi.fn(),start:vi.fn()}));
vi.mock('@clerk/nextjs',()=>({useAuth:()=>({isLoaded:state.loaded,isSignedIn:state.signedIn,getToken:state.getToken}),useOrganization:()=>({isLoaded:state.loaded,organization:state.org}),OrganizationSwitcher:()=> <span>Choose organization</span>,SignIn:()=> <span>Sign in</span>}));
vi.mock('../../shell/src/lib/slack-install',()=>({startSlackInstallation:state.start}));
import { SlackInstallation } from '../../shell/src/components/auth/SlackInstallation';
afterEach(cleanup);
beforeEach(()=>{state.loaded=true;state.signedIn=true;state.org={id:'org_team',name:'Team'};state.start.mockReset();});
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
  it('never shows success just because installation was started',async()=>{
    state.start.mockResolvedValue({status:'unavailable'});render(<SlackInstallation />);
    fireEvent.click(screen.getByRole('button',{name:'Add to Slack'}));
    await waitFor(()=>expect(screen.getByRole('alert').textContent).toContain('try again'));
    expect(screen.queryByText('Slack connected')).toBeNull();
  });
});
