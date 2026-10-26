// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('@clerk/nextjs',()=>({
 SignIn:({forceRedirectUrl,fallbackRedirectUrl,signUpUrl}:{forceRedirectUrl:string;fallbackRedirectUrl:string;signUpUrl:string})=><a data-testid="signin" data-force={forceRedirectUrl} data-fallback={fallbackRedirectUrl} href={signUpUrl}>Create account</a>,
 SignUp:({forceRedirectUrl,fallbackRedirectUrl,signInUrl}:{forceRedirectUrl:string;fallbackRedirectUrl:string;signInUrl:string})=><a data-testid="signup" data-force={forceRedirectUrl} data-fallback={fallbackRedirectUrl} href={signInUrl}>Existing account</a>,
}));
vi.mock('../../shell/src/components/auth/ShellAuthLayout',()=>({ShellAuthLayout:({children}:{children:React.ReactNode})=><div>{children}</div>}));
vi.mock('../../shell/src/components/auth/auth-brand',()=>({shellAuthAppearance:{}}));
import SignInPage from '../../shell/src/app/sign-in/[[...sign-in]]/page';
import SignUpPage from '../../shell/src/app/sign-up/[[...sign-up]]/page';
afterEach(cleanup);
const tokenTarget='/slack/link?token='+'a'.repeat(43);
const params=(redirect_url:string|string[]|undefined)=>({searchParams:Promise.resolve({redirect_url})});
describe('Slack return through shared account pages',()=>{
 for(const target of ['/slack/install',tokenTarget])it('retains '+target.split('?')[0]+' through sign-in/sign-up and back',async()=>{
  const first=render(await SignInPage(params(target)));
  const signIn=screen.getByTestId('signin');
  expect(signIn.getAttribute('data-force')).toBe(target);expect(signIn.getAttribute('data-fallback')).toBe(target);
  const signUpUrl=new URL(signIn.getAttribute('href')!,'https://app.matrix-os.com');
  expect(signUpUrl.pathname).toBe('/sign-up');expect(signUpUrl.searchParams.get('redirect_url')).toBe(target);first.unmount();
  const second=render(await SignUpPage(params(signUpUrl.searchParams.get('redirect_url')!)));
  const signUp=screen.getByTestId('signup');
  expect(signUp.getAttribute('data-force')).toBe(target);expect(signUp.getAttribute('data-fallback')).toBe(target);
  const signInUrl=new URL(signUp.getAttribute('href')!,'https://app.matrix-os.com');
  expect(signInUrl.pathname).toBe('/sign-in');expect(signInUrl.searchParams.get('redirect_url')).toBe(target);second.unmount();
  render(await SignInPage(params(signInUrl.searchParams.get('redirect_url')!)));
  expect(screen.getByTestId('signin').getAttribute('data-force')).toBe(target);
 });
 for(const target of [undefined,['/slack/install','/slack/install'],'https://evil.test/slack/install','//evil.test/slack/install','/slack/install?extra=x',tokenTarget+'&extra=x'])it('keeps ordinary and unsafe sign-up redirects at app home: '+String(target),async()=>{
  render(await SignUpPage(params(target)));
  const signup=screen.getByTestId('signup');expect(signup.getAttribute('data-force')).toBe('/');expect(signup.getAttribute('data-fallback')).toBe('/');expect(signup.getAttribute('href')).toBe('/sign-in');
 });
});
